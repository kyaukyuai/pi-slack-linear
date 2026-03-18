import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./lib/config.js";
import { HeartbeatService } from "./lib/heartbeat.js";
import { verifyLinearCli } from "./lib/linear.js";
import { Logger } from "./lib/logger.js";
import { buildHeartbeatReviewDecision, buildManagerReview, formatControlRoomReviewForSlack, handleManagerMessage, type ManagerReviewResult } from "./lib/manager.js";
import { ensureManagerSystemFiles } from "./lib/manager-state.js";
import { disposeAllThreadRuntimes, disposeIdleThreadRuntimes, runAgentTurn, runSystemTurn } from "./lib/pi-session.js";
import { SchedulerService } from "./lib/scheduler.js";
import { formatSlackMessageText } from "./lib/slack-format.js";
import { classifyTaskIntent, isProcessableSlackMessage, normalizeSlackMessage, type RawSlackMessageEvent } from "./lib/slack.js";
import { buildHeartbeatPaths, buildSchedulerPaths, buildSystemPaths, ensureSystemWorkspace } from "./lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "./state/repositories/file-backed-manager-repositories.js";
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

async function formatManagerReviewForSlack(
  webClient: WebClient,
  logger: Logger,
  result: ManagerReviewResult,
): Promise<string> {
  if (!result.followup) {
    return formatControlRoomReviewForSlack(result);
  }

  const fallbackThreadRef = result.followup.source
    ? `${result.followup.source.channelId} / ${result.followup.source.rootThreadTs}`
    : "source thread unavailable";
  let threadReference = fallbackThreadRef;

  if (result.followup.source) {
    try {
      const permalink = await webClient.chat.getPermalink({
        channel: result.followup.source.channelId,
        message_ts: result.followup.source.sourceMessageTs,
      });
      if (permalink.permalink) {
        threadReference = permalink.permalink;
      }
    } catch (error) {
      logger.warn("Failed to resolve Slack permalink for manager follow-up", {
        issueId: result.followup.issueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return formatControlRoomReviewForSlack(result, threadReference);
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
  const systemPaths = buildSystemPaths(config.workspaceDir);
  const cleanupTimer = setInterval(() => {
    void disposeIdleThreadRuntimes().catch((error) => {
      logger.warn("Idle thread runtime cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  await ensureSystemWorkspace(systemPaths);
  await ensureManagerSystemFiles(systemPaths);
  await verifyLinearCli(config.linearTeamKey);
  const managerRepositories = createFileBackedManagerRepositories(systemPaths);
  const managerPolicy = await managerRepositories.policy.load();

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
    heartbeatIntervalMin: managerPolicy.heartbeatIntervalMin,
    schedulerPollSec: config.schedulerPollSec,
    controlRoomChannelId: managerPolicy.controlRoomChannelId,
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
        const managerResult = await handleManagerMessage(
          config,
          systemPaths,
          {
            channelId: message.channelId,
            rootThreadTs: message.rootThreadTs,
            messageTs: message.ts,
            userId: message.userId,
            text: message.text,
          },
          managerRepositories,
        );

        const reply = managerResult.handled
          ? managerResult.reply ?? "対応しました。"
          : await runAgentTurn(config, paths, {
              channelId: message.channelId,
              userId: message.userId,
              text: message.text,
              rootThreadTs: message.rootThreadTs,
              intent,
              attachments,
            });

        const formattedReply = formatSlackMessageText(reply);
        await webClient.chat.postMessage({
          channel: message.channelId,
          thread_ts: message.rootThreadTs,
          text: formattedReply,
        });

        await appendThreadLog(paths, {
          type: "assistant",
          ts: `${Date.now() / 1000}`,
          threadTs: message.rootThreadTs,
          text: formattedReply,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Failed to process Slack message", {
          channelId: message.channelId,
          threadTs: message.rootThreadTs,
          error: errorMessage,
        });

        const reply = formatSlackMessageText(`処理に失敗しました。設定や Linear 連携を確認してください。\n\n${errorMessage}`);
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

  const heartbeatService = new HeartbeatService({
    logger,
    workspaceDir: config.workspaceDir,
    systemPaths,
    allowedChannelIds: config.slackAllowedChannelIds,
    intervalMin: managerPolicy.heartbeatIntervalMin,
    activeLookbackHours: config.heartbeatActiveLookbackHours,
    executeHeartbeat: async ({ channelId, prompt }) => {
      const paths = buildHeartbeatPaths(config.workspaceDir, channelId);
      await ensureThreadWorkspace(paths);
      await appendThreadLog(paths, {
        type: "system",
        ts: `${Date.now() / 1000}`,
        threadTs: "heartbeat",
        text: prompt,
      });

      const decision = await buildHeartbeatReviewDecision(config, systemPaths, managerRepositories);
      if (!decision.review) {
        const reason = decision.reason ?? "no-urgent-items";
        const reply = `heartbeat noop: ${reason}`;
        await appendThreadLog(paths, {
          type: "system",
          ts: `${Date.now() / 1000}`,
          threadTs: "heartbeat",
          text: reply,
        });
        return { reply, status: "noop", reason };
      }
      const review = decision.review;
      const reply = formatSlackMessageText(await formatManagerReviewForSlack(webClient, logger, review));
      await webClient.chat.postMessage({
        channel: channelId,
        text: reply,
      });

      await appendThreadLog(paths, {
        type: "assistant",
        ts: `${Date.now() / 1000}`,
        threadTs: "heartbeat",
        text: reply,
      });

      return { reply, status: "posted" as const };
    },
  });
  await heartbeatService.start();

  const schedulerService = new SchedulerService({
    logger,
    systemPaths,
    pollSec: config.schedulerPollSec,
    executeJob: async ({ job }) => {
      if (!config.slackAllowedChannelIds.has(job.channelId)) {
        throw new Error(`Job channel ${job.channelId} is not in SLACK_ALLOWED_CHANNEL_IDS`);
      }

      if (job.action) {
        const mappedKind = job.action;
        const review = await buildManagerReview(config, systemPaths, mappedKind, managerRepositories);
        if (!review) {
          return {
            delivered: false,
            summary: "No review output",
          };
        }
        const reply = formatSlackMessageText(await formatManagerReviewForSlack(webClient, logger, review));

        await webClient.chat.postMessage({
          channel: job.channelId,
          text: reply,
        });

        return {
          delivered: true,
          summary: reply,
        };
      }

      const paths = buildSchedulerPaths(config.workspaceDir, job.id);
      await ensureThreadWorkspace(paths);
      await appendThreadLog(paths, {
        type: "system",
        ts: `${Date.now() / 1000}`,
        threadTs: job.id,
        text: job.prompt,
      });

      const reply = formatSlackMessageText(await runSystemTurn(config, paths, {
        kind: "scheduler",
        channelId: job.channelId,
        text: job.prompt,
        metadata: {
          jobId: job.id,
          scheduleKind: job.kind,
        },
      }));

      await webClient.chat.postMessage({
        channel: job.channelId,
        text: reply,
      });

      await appendThreadLog(paths, {
        type: "assistant",
        ts: `${Date.now() / 1000}`,
        threadTs: job.id,
        text: reply,
      });

      return {
        delivered: true,
        summary: reply,
      };
    },
  });
  await schedulerService.start();

  const shutdown = async (signal: string) => {
    logger.info("Shutting down", { signal });
    clearInterval(cleanupTimer);
    heartbeatService.stop();
    schedulerService.stop();
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
