import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./lib/config.js";
import { HeartbeatService } from "./lib/heartbeat.js";
import { verifyLinearCli } from "./lib/linear.js";
import { Logger } from "./lib/logger.js";
import { handleManagerMessage } from "./lib/manager.js";
import { commitManagerCommandProposals } from "./lib/manager-command-commit.js";
import { ensureManagerStateFiles } from "./lib/manager-state.js";
import { analyzeOwnerMap } from "./lib/owner-map-diagnostics.js";
import { disposeAllThreadRuntimes, disposeIdleThreadRuntimes, runManagerSystemTurn } from "./lib/pi-session.js";
import { SchedulerService } from "./lib/scheduler.js";
import { buildSlackMessagePayload } from "./lib/slack-format.js";
import { mergeSystemReply } from "./lib/system-slack-reply.js";
import { isProcessableSlackMessage, normalizeSlackMessage, type RawSlackMessageEvent } from "./lib/slack.js";
import { buildHeartbeatPaths, buildSchedulerPaths, buildSystemPaths, ensureSystemWorkspace, type SchedulerJob } from "./lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "./state/repositories/file-backed-manager-repositories.js";
import { runWorkgraphMaintenance } from "./state/workgraph/maintenance.js";
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

async function postSlackReply(
  webClient: WebClient,
  args: {
    channel: string;
    reply: string;
    threadTs?: string;
    linearWorkspace: string;
  },
): Promise<string> {
  const payload = buildSlackMessagePayload(args.reply, { linearWorkspace: args.linearWorkspace });
  await webClient.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: payload.text,
    blocks: payload.blocks,
  });
  return payload.text;
}

function extractSchedulerRunCommitSummary(rawReply: string, postedReply: string): string | undefined {
  const systemLogLine = rawReply
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^>\s*system log:\s*/i.test(line));
  if (systemLogLine) {
    return systemLogLine.replace(/^>\s*system log:\s*/i, "").trim();
  }

  const firstParagraph = rawReply
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .find(Boolean);
  const collapsed = (firstParagraph ?? postedReply)
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || undefined;
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
  await ensureManagerStateFiles(systemPaths);
  await verifyLinearCli(config.linearTeamKey);
  const managerRepositories = createFileBackedManagerRepositories(systemPaths);
  let managerPolicy = await managerRepositories.policy.load();
  const ownerMap = await managerRepositories.ownerMap.load();
  const workgraphPolicy = {
    warnActiveLogEvents: config.workgraphHealthWarnActiveEvents,
    autoCompactMaxActiveLogEvents: config.workgraphAutoCompactMaxActiveEvents,
  };
  const ownerMapDiagnostics = analyzeOwnerMap(ownerMap);

  if (ownerMapDiagnostics.unmappedSlackEntries.length > 0) {
    logger.warn("Owner map has entries without slackUserId mapping", {
      unmappedEntries: ownerMapDiagnostics.unmappedSlackEntries.map((entry) => ({
        id: entry.id,
        linearAssignee: entry.linearAssignee,
      })),
    });
  }
  if (ownerMapDiagnostics.duplicateSlackUserIds.length > 0) {
    logger.warn("Owner map has duplicate slackUserId mappings", {
      duplicateSlackUserIds: ownerMapDiagnostics.duplicateSlackUserIds,
    });
  }

  const logWorkgraphMaintenance = async (source: "startup" | "interval"): Promise<void> => {
    try {
      const result = await runWorkgraphMaintenance(managerRepositories.workgraph, workgraphPolicy);
      if (result.action === "compacted") {
        logger.info("Workgraph compacted automatically", {
          source,
          activeLogEventCountBefore: result.before.activeLogEventCount,
          activeLogEventCountAfter: result.after?.activeLogEventCount,
          snapshotEventCount: result.after?.snapshotEventCount ?? result.snapshot?.eventCount,
          compactedEventCount: result.after?.compactedEventCount ?? result.snapshot?.compactedEventCount,
        });
        return;
      }
      if (result.action === "recovery-required") {
        logger.warn("Workgraph health check requires recovery", {
          source,
          snapshotEventCount: result.before.snapshotEventCount,
          compactedEventCount: result.before.compactedEventCount,
          activeLogEventCount: result.before.activeLogEventCount,
          snapshotInvalid: result.before.snapshotInvalid,
          snapshotAheadOfLog: result.before.snapshotAheadOfLog,
        });
        return;
      }
      if (result.before.status === "warning") {
        logger.warn("Workgraph health check warning", {
          source,
          activeLogEventCount: result.before.activeLogEventCount,
          replayTailEventCount: result.before.replayTailEventCount,
          compactRecommended: result.before.compactRecommended,
        });
        return;
      }
      logger.debug("Workgraph health check ok", {
        source,
        activeLogEventCount: result.before.activeLogEventCount,
        replayTailEventCount: result.before.replayTailEventCount,
        snapshotEventCount: result.before.snapshotEventCount,
      });
    } catch (error) {
      logger.warn("Workgraph maintenance failed", {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await logWorkgraphMaintenance("startup");
  if (config.workgraphMaintenanceIntervalMin > 0) {
    const workgraphTimer = setInterval(() => {
      void logWorkgraphMaintenance("interval");
    }, config.workgraphMaintenanceIntervalMin * 60 * 1000);
    workgraphTimer.unref();
  }

  const authTest = await webClient.auth.test();
  const botUserId = authTest.user_id;

  if (!botUserId) {
    throw new Error("Unable to resolve Slack bot user ID");
  }

  const currentDateInJst = () => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const currentDateTimeInJst = () => {
    const formatted = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    return `${formatted} JST`;
  };

  const linearEnv = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
  let heartbeatService: HeartbeatService | undefined;

  const executeManagerSystemTask = async (args: {
    paths: ReturnType<typeof buildThreadPaths>;
    input: Parameters<typeof runManagerSystemTurn>[2];
    fallback: () => Promise<string>;
  }): Promise<string> => {
    try {
      const agentResult = await runManagerSystemTurn(config, args.paths, args.input);
      const commitResult = await commitManagerCommandProposals({
        config,
        repositories: managerRepositories,
        proposals: agentResult.proposals,
        message: {
          channelId: args.input.channelId,
          rootThreadTs: args.input.rootThreadTs,
          messageTs: args.input.messageTs,
          text: args.input.text,
        },
        now: new Date(),
        policy: managerPolicy,
        env: linearEnv,
        runSchedulerJobNow: async (job) => {
          try {
            const result = await executeCustomSchedulerJob(job, "manual");
            return {
              status: "ok" as const,
              persistedSummary: result.postedReply,
              commitSummary: result.commitSummary,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
              status: "error" as const,
              persistedSummary: errorMessage,
              commitSummary: errorMessage,
            };
          }
        },
      });
      logger.info("Manager system agent result", {
        intent: agentResult.intentReport?.intent,
        queryKind: agentResult.intentReport?.queryKind,
        queryScope: agentResult.intentReport?.queryScope,
        toolCalls: agentResult.toolCalls.map((call) => call.toolName),
        proposalCount: agentResult.proposals.length,
        invalidProposalCount: agentResult.invalidProposalCount,
        committedCommands: commitResult.committed.map((entry) => entry.commandType),
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
        channelId: args.input.channelId,
        threadTs: args.input.rootThreadTs,
      });
      return mergeSystemReply({
        agentReply: agentResult.reply,
        commitSummaries: commitResult.replySummaries,
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
      });
    } catch (error) {
      logger.warn("Manager system agent fell back to safety-only response", {
        channelId: args.input.channelId,
        threadTs: args.input.rootThreadTs,
        error: error instanceof Error ? error.message : String(error),
      });
      return args.fallback();
    }
  };

  const executeCustomSchedulerJob = async (
    job: SchedulerJob,
    trigger: "scheduled" | "manual",
  ): Promise<{
    postedReply: string;
    rawReply: string;
    commitSummary?: string;
  }> => {
    const paths = buildSchedulerPaths(config.workspaceDir, job.id);
    await ensureThreadWorkspace(paths);
    await appendThreadLog(paths, {
      type: "system",
      ts: `${Date.now() / 1000}`,
      threadTs: job.id,
      text: job.prompt,
    });

    const rawReply = await executeManagerSystemTask({
      paths,
      input: {
        kind: "scheduler",
        channelId: job.channelId,
        rootThreadTs: job.id,
        messageTs: job.id,
        currentDate: currentDateInJst(),
        runAtJst: currentDateTimeInJst(),
        text: job.prompt,
        metadata: {
          jobId: job.id,
          scheduleKind: job.kind,
          trigger,
        },
      },
      fallback: async () => "処理に失敗しました。設定や連携を確認してください。",
    });

    const postedReply = await postSlackReply(webClient, {
      channel: job.channelId,
      reply: rawReply,
      linearWorkspace: config.linearWorkspace,
    });

    await appendThreadLog(paths, {
      type: "assistant",
      ts: `${Date.now() / 1000}`,
      threadTs: job.id,
      text: postedReply,
    });

    return {
      postedReply,
      rawReply,
      commitSummary: extractSchedulerRunCommitSummary(rawReply, postedReply),
    };
  };

  logger.info("Slack assistant starting", {
    assistantName: managerPolicy.assistantName,
    channels: Array.from(config.slackAllowedChannelIds),
    model: config.botModel,
    linearWorkspace: config.linearWorkspace,
    linearTeamKey: config.linearTeamKey,
    heartbeatEnabled: managerPolicy.heartbeatEnabled,
    heartbeatIntervalMin: managerPolicy.heartbeatIntervalMin,
    heartbeatActiveLookbackHours: managerPolicy.heartbeatActiveLookbackHours,
    schedulerPollSec: config.schedulerPollSec,
    controlRoomChannelId: managerPolicy.controlRoomChannelId,
    workgraphMaintenanceIntervalMin: config.workgraphMaintenanceIntervalMin,
    workgraphHealthWarnActiveEvents: config.workgraphHealthWarnActiveEvents,
    workgraphAutoCompactMaxActiveEvents: config.workgraphAutoCompactMaxActiveEvents,
    ownerMapTotalEntries: ownerMapDiagnostics.totalEntries,
    ownerMapMappedSlackEntries: ownerMapDiagnostics.mappedSlackEntries,
    ownerMapUnmappedSlackEntries: ownerMapDiagnostics.unmappedSlackEntries.length,
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
          undefined,
          {
            runSchedulerJobNow: async (job) => {
              try {
                const result = await executeCustomSchedulerJob(job, "manual");
                return {
                  status: "ok" as const,
                  persistedSummary: result.postedReply,
                  commitSummary: result.commitSummary,
                };
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                  status: "error" as const,
                  persistedSummary: errorMessage,
                  commitSummary: errorMessage,
                };
              }
            },
          },
        );
        if (managerResult.diagnostics?.agent) {
          const agent = managerResult.diagnostics.agent;
          const logPayload = {
            intent: agent.intent,
            queryKind: agent.queryKind,
            queryScope: agent.queryScope,
            confidence: agent.confidence,
            reasoningSummary: agent.reasoningSummary,
            toolCalls: agent.toolCalls,
            proposalCount: agent.proposalCount,
            invalidProposalCount: agent.invalidProposalCount,
            committedCommands: agent.committedCommands,
            commitRejections: agent.commitRejections,
            pendingClarificationDecision: agent.pendingClarificationDecision,
            pendingClarificationPersistence: agent.pendingClarificationPersistence,
            pendingClarificationDecisionSummary: agent.pendingClarificationDecisionSummary,
            missingQuerySnapshot: agent.missingQuerySnapshot,
            technicalFailure: agent.technicalFailure,
            channelId: message.channelId,
            threadTs: message.rootThreadTs,
          };
          if (agent.source === "fallback") {
            logger.warn("Manager agent fell back to safety-only response", logPayload);
          } else {
            logger.info("Manager agent decision", logPayload);
          }
        }
        if (managerResult.diagnostics?.router) {
          const router = managerResult.diagnostics.router;
          const logPayload = {
            action: router.action,
            queryKind: router.queryKind,
            queryScope: router.queryScope,
            confidence: router.confidence,
            reasoningSummary: router.reasoningSummary,
            technicalFailure: router.technicalFailure,
            channelId: message.channelId,
            threadTs: message.rootThreadTs,
          };
          if (router.source === "fallback") {
            logger.warn("Manager fallback routing decided a safety-only response", logPayload);
          } else {
            logger.info("Manager router decision", logPayload);
          }
        }

        if (heartbeatService && managerResult.diagnostics?.agent?.committedCommands.includes("update_builtin_schedule")) {
          managerPolicy = await managerRepositories.policy.load();
          await heartbeatService.reconfigure({
            intervalMin: managerPolicy.heartbeatEnabled ? managerPolicy.heartbeatIntervalMin : 0,
            activeLookbackHours: managerPolicy.heartbeatActiveLookbackHours,
          });
        }

        const reply = managerResult.reply ?? "必要なことを少し具体的に教えてください。";

        const formattedReply = await postSlackReply(webClient, {
          channel: message.channelId,
          threadTs: message.rootThreadTs,
          reply,
          linearWorkspace: config.linearWorkspace,
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

        const reply = await postSlackReply(webClient, {
          channel: message.channelId,
          threadTs: message.rootThreadTs,
          reply: `処理に失敗しました。設定や Linear 連携を確認してください。\n\n${errorMessage}`,
          linearWorkspace: config.linearWorkspace,
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
  logger.info("Slack assistant connected", {
    assistantName: managerPolicy.assistantName,
  });

  heartbeatService = new HeartbeatService({
    logger,
    workspaceDir: config.workspaceDir,
    systemPaths,
    allowedChannelIds: config.slackAllowedChannelIds,
    intervalMin: managerPolicy.heartbeatEnabled ? managerPolicy.heartbeatIntervalMin : 0,
    activeLookbackHours: managerPolicy.heartbeatActiveLookbackHours,
    executeHeartbeat: async ({ channelId, prompt }) => {
      const paths = buildHeartbeatPaths(config.workspaceDir, channelId);
      await ensureThreadWorkspace(paths);
      await appendThreadLog(paths, {
        type: "system",
        ts: `${Date.now() / 1000}`,
        threadTs: "heartbeat",
        text: prompt,
      });

      const reply = await executeManagerSystemTask({
        paths,
        input: {
          kind: "heartbeat",
          channelId,
          rootThreadTs: "heartbeat",
          messageTs: "heartbeat",
          currentDate: currentDateInJst(),
          runAtJst: currentDateTimeInJst(),
          text: prompt,
        },
        fallback: async () => {
          return "heartbeat noop: agent-fallback";
        },
      });
      if (reply.startsWith("heartbeat noop:")) {
        const rawReason = reply.replace("heartbeat noop:", "").trim();
        const reason = (
          rawReason === "outside-business-hours"
          || rawReason === "no-active-channels"
          || rawReason === "suppressed-by-cooldown"
        ) ? rawReason : "no-urgent-items";
        await appendThreadLog(paths, {
          type: "system",
          ts: `${Date.now() / 1000}`,
          threadTs: "heartbeat",
          text: reply,
        });
        return { reply, status: "noop", reason };
      }
      const postedReply = await postSlackReply(webClient, {
        channel: channelId,
        reply,
        linearWorkspace: config.linearWorkspace,
      });

      await appendThreadLog(paths, {
        type: "assistant",
        ts: `${Date.now() / 1000}`,
        threadTs: "heartbeat",
        text: postedReply,
      });

      return { reply: postedReply, status: "posted" as const };
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
        const paths = buildSchedulerPaths(config.workspaceDir, job.id);
        await ensureThreadWorkspace(paths);
        const reply = await executeManagerSystemTask({
          paths,
        input: {
          kind: mappedKind,
            channelId: job.channelId,
            rootThreadTs: job.id,
            messageTs: job.id,
            currentDate: currentDateInJst(),
            runAtJst: currentDateTimeInJst(),
            text: job.prompt,
            metadata: {
              jobId: job.id,
              scheduleKind: job.kind,
              reviewKind: mappedKind,
            },
          },
          fallback: async () => {
            return "Manager review is temporarily unavailable. Please retry this review from the control room if needed.";
          },
        });
        if (reply === "Manager review is temporarily unavailable. Please retry this review from the control room if needed.") {
          return {
            delivered: false,
            summary: reply,
          };
        }

        const postedReply = await postSlackReply(webClient, {
          channel: job.channelId,
          reply,
          linearWorkspace: config.linearWorkspace,
        });

        return {
          delivered: true,
          summary: postedReply,
        };
      }

      const result = await executeCustomSchedulerJob(job, "scheduled");
      return {
        delivered: true,
        summary: result.postedReply,
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
