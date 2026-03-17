import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./lib/config.js";
import { verifyLinearCli } from "./lib/linear.js";
import { Logger } from "./lib/logger.js";
import { disposeAllThreadRuntimes, disposeIdleThreadRuntimes, runAgentTurn } from "./lib/pi-session.js";
import { classifyTaskIntent, isProcessableSlackMessage, normalizeSlackMessage, type RawSlackMessageEvent } from "./lib/slack.js";
import {
  appendThreadLog,
  buildThreadPaths,
  ensureThreadWorkspace,
  type AttachmentRecord,
} from "./lib/thread-workspace.js";

class ThreadQueue {
  private readonly jobs = new Map<string, Promise<void>>();

  enqueue(key: string, job: () => Promise<void>): void {
    const previous = this.jobs.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(job)
      .finally(() => {
        if (this.jobs.get(key) === current) {
          this.jobs.delete(key);
        }
      });

    this.jobs.set(key, current);
  }
}

async function downloadAttachments(
  token: string,
  attachmentsDir: string,
  files: RawSlackMessageEvent["files"] = [],
): Promise<AttachmentRecord[]> {
  if (files.length === 0) return [];

  await mkdir(attachmentsDir, { recursive: true });
  const results: AttachmentRecord[] = [];

  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;

    const safeName = `${file.id ?? Date.now()}-${basename(file.name)}`;
    const storedPath = join(attachmentsDir, safeName);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download Slack attachment: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(storedPath, buffer);
    results.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimetype,
      storedPath,
    });
  }

  return results;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const queue = new ThreadQueue();
  const socketClient = new SocketModeClient({ appToken: config.slackAppToken });
  const webClient = new WebClient(config.slackBotToken);
  const cleanupTimer = setInterval(() => {
    void disposeIdleThreadRuntimes().catch((error) => {
      logger.warn("Idle thread runtime cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  await verifyLinearCli(config.linearTeamKey);

  const authTest = await webClient.auth.test();
  const botUserId = authTest.user_id;

  if (!botUserId) {
    throw new Error("Unable to resolve Slack bot user ID");
  }

  logger.info("Slack bot starting", {
    channels: Array.from(config.slackAllowedChannelIds),
    model: config.botModel,
    linearWorkspace: config.linearWorkspace,
    linearTeamKey: config.linearTeamKey,
  });

  socketClient.on("message", async ({ event, ack }) => {
    await ack();

    const rawEvent = event as RawSlackMessageEvent;
    if (!isProcessableSlackMessage(rawEvent, botUserId, config.slackAllowedChannelIds)) {
      return;
    }

    const message = normalizeSlackMessage(rawEvent);
    const threadKey = `${message.channelId}:${message.rootThreadTs}`;

    queue.enqueue(threadKey, async () => {
      const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
      await ensureThreadWorkspace(paths);

      let attachments: AttachmentRecord[] = [];
      try {
        attachments = await downloadAttachments(config.slackBotToken, paths.attachmentsDir, message.files);
      } catch (error) {
        logger.warn("Attachment download failed", {
          channelId: message.channelId,
          threadTs: message.rootThreadTs,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await appendThreadLog(paths, {
        type: "user",
        ts: message.ts,
        threadTs: message.rootThreadTs,
        userId: message.userId,
        text: message.text,
        attachments,
      });

      const intent = classifyTaskIntent(message.text);

      try {
        const reply = await runAgentTurn(config, paths, {
          channelId: message.channelId,
          userId: message.userId,
          text: message.text,
          rootThreadTs: message.rootThreadTs,
          intent,
          attachments,
        });

        await webClient.chat.postMessage({
          channel: message.channelId,
          thread_ts: message.rootThreadTs,
          text: reply,
        });

        await appendThreadLog(paths, {
          type: "assistant",
          ts: `${Date.now() / 1000}`,
          threadTs: message.rootThreadTs,
          text: reply,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Failed to process Slack message", {
          channelId: message.channelId,
          threadTs: message.rootThreadTs,
          error: errorMessage,
        });

        const reply = `処理に失敗しました。設定や Linear 連携を確認してください。\n\n${errorMessage}`;
        await webClient.chat.postMessage({
          channel: message.channelId,
          thread_ts: message.rootThreadTs,
          text: reply,
        });

        await appendThreadLog(paths, {
          type: "system",
          ts: `${Date.now() / 1000}`,
          threadTs: message.rootThreadTs,
          text: reply,
        });
      }
    });
  });

  await socketClient.start();
  logger.info("Slack bot connected");

  const shutdown = async (signal: string) => {
    logger.info("Shutting down", { signal });
    clearInterval(cleanupTimer);
    await socketClient.disconnect();
    await disposeAllThreadRuntimes();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
