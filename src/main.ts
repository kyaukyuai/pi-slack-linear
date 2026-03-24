import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { basename, join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./lib/config.js";
import { HeartbeatService } from "./lib/heartbeat.js";
import { ensureLinearIssueCreatedWebhook, getLinearIssue, verifyLinearCli } from "./lib/linear.js";
import {
  LINEAR_ISSUE_CREATED_WEBHOOK_LABEL,
  isDuplicateWebhookDelivery,
  isLoopedWebhookIssue,
  parseLinearWebhookEvent,
  updateWebhookDeliveryStatus,
  upsertWebhookDelivery,
  verifyLinearWebhookRequest,
} from "./lib/linear-webhook.js";
import { Logger } from "./lib/logger.js";
import { handleManagerMessage } from "./lib/manager.js";
import { commitManagerCommandProposals } from "./lib/manager-command-commit.js";
import { ensureManagerStateFiles } from "./lib/manager-state.js";
import { analyzeOwnerMap } from "./lib/owner-map-diagnostics.js";
import { handleIssueCreatedWebhook } from "./orchestrators/webhooks/handle-issue-created.js";
import { disposeAllThreadRuntimes, disposeIdleThreadRuntimes, runManagerSystemTurn } from "./lib/pi-session.js";
import { SchedulerService } from "./lib/scheduler.js";
import { postSlackProcessingNotice, sendSlackReply } from "./lib/slack-replies.js";
import { mergeSystemReply } from "./lib/system-slack-reply.js";
import { isProcessableSlackMessage, normalizeSlackMessage, type RawSlackMessageEvent } from "./lib/slack.js";
import {
  buildHeartbeatPaths,
  buildSchedulerPaths,
  buildSystemPaths,
  buildWebhookPaths,
  ensureSystemWorkspace,
  type SchedulerJob,
} from "./lib/system-workspace.js";
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

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
  const webhookQueue = new ThreadQueue();
  const socketClient = new SocketModeClient({ appToken: config.slackAppToken });
  const webClient = new WebClient(config.slackBotToken);
  const systemPaths = buildSystemPaths(config.workspaceDir);
  let webhookListenerEnabled = config.linearWebhookEnabled;
  let ensuredWebhookId: string | undefined;
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

    const postedReply = await sendSlackReply(webClient, {
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

  if (config.linearWebhookEnabled) {
    try {
      const ensuredWebhook = await ensureLinearIssueCreatedWebhook(
        {
          label: LINEAR_ISSUE_CREATED_WEBHOOK_LABEL,
          url: `${config.linearWebhookPublicUrl}${config.linearWebhookPath}`,
          teamKey: config.linearTeamKey,
          secret: config.linearWebhookSecret ?? "",
        },
        linearEnv,
      );
      if (ensuredWebhook.status === "disabled-duplicate") {
        webhookListenerEnabled = false;
        logger.error("Linear webhook auto-processing disabled because multiple matching webhooks exist", {
          webhookLabel: LINEAR_ISSUE_CREATED_WEBHOOK_LABEL,
          duplicateWebhookIds: ensuredWebhook.duplicateWebhooks?.map((entry) => entry.id),
        });
      } else {
        ensuredWebhookId = ensuredWebhook.webhook?.id;
        logger.info("Linear issue-created webhook reconciled", {
          webhookLabel: LINEAR_ISSUE_CREATED_WEBHOOK_LABEL,
          webhookStatus: ensuredWebhook.status,
          webhookId: ensuredWebhook.webhook?.id,
          webhookUrl: ensuredWebhook.webhook?.url,
        });
      }
    } catch (error) {
      logger.error("Linear webhook reconcile failed", {
        webhookLabel: LINEAR_ISSUE_CREATED_WEBHOOK_LABEL,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const processIssueCreatedWebhookDelivery = async (event: {
    deliveryId: string;
    webhookId?: string;
    issueId: string;
    issueIdentifier: string;
    receivedAt: string;
  }): Promise<void> => {
    const currentPolicy = await managerRepositories.policy.load();
    const deliveries = await managerRepositories.webhookDeliveries.load();
    if (isLoopedWebhookIssue(deliveries, event.issueId, event.issueIdentifier)) {
      const nextDeliveries = updateWebhookDeliveryStatus(deliveries, event.deliveryId, {
        status: "ignored-loop",
        reason: `${event.issueIdentifier} was created by prior webhook automation`,
      });
      await managerRepositories.webhookDeliveries.save(nextDeliveries);
      logger.info("Ignored webhook issue create due to loop prevention", {
        deliveryId: event.deliveryId,
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
      });
      return;
    }

    const issue = await getLinearIssue(event.issueIdentifier, linearEnv).catch(async () => {
      return getLinearIssue(event.issueId, linearEnv);
    });
    if (!issue.identifier.startsWith(`${config.linearTeamKey}-`)) {
      const nextDeliveries = updateWebhookDeliveryStatus(deliveries, event.deliveryId, {
        status: "ignored-unsupported",
        reason: `${issue.identifier} is outside team ${config.linearTeamKey}`,
      });
      await managerRepositories.webhookDeliveries.save(nextDeliveries);
      logger.info("Ignored webhook issue create outside configured team", {
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
      });
      return;
    }

    const paths = buildWebhookPaths(config.workspaceDir, issue.identifier);
    await ensureThreadWorkspace(paths);
    await appendThreadLog(paths, {
      type: "system",
      ts: `${Date.now() / 1000}`,
      threadTs: `webhook:${issue.identifier}`,
      text: `linear webhook issue created: ${issue.identifier}`,
    });

    const result = await handleIssueCreatedWebhook({
      config,
      paths,
      repositories: managerRepositories,
      policy: currentPolicy,
      issue,
      deliveryId: event.deliveryId,
      webhookId: event.webhookId,
      now: new Date(),
      env: linearEnv,
      currentDate: currentDateInJst(),
      runAtJst: currentDateTimeInJst(),
      runSchedulerJobNow: async (job) => {
        try {
          const runResult = await executeCustomSchedulerJob(job, "manual");
          return {
            status: "ok" as const,
            persistedSummary: runResult.postedReply,
            commitSummary: runResult.commitSummary,
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

    const nextDeliveries = updateWebhookDeliveryStatus(
      await managerRepositories.webhookDeliveries.load(),
      event.deliveryId,
      {
        status: result.status,
        reason: result.reason,
        createdIssueIds: result.createdIssueIds,
      },
    );
    await managerRepositories.webhookDeliveries.save(nextDeliveries);

    if (result.agentResult) {
      logger.info("Manager webhook agent result", {
        intent: result.agentResult.intentReport?.intent,
        queryKind: result.agentResult.intentReport?.queryKind,
        queryScope: result.agentResult.intentReport?.queryScope,
        toolCalls: result.agentResult.toolCalls.map((call) => call.toolName),
        proposalCount: result.agentResult.proposals.length,
        invalidProposalCount: result.agentResult.invalidProposalCount,
        committedCommands: result.commitResult?.committed.map((entry) => entry.commandType) ?? [],
        commitRejections: result.commitResult?.rejected.map((entry) => entry.reason) ?? [],
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
      });
    }

    if (result.status === "noop") {
      logger.info("Webhook issue create resulted in no-op", {
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
      });
      return;
    }

    const notificationReply = result.status === "committed"
      ? [`${issue.identifier} に対して自動処理を実施しました。`, result.reply].filter(Boolean).join("\n\n")
      : [`${issue.identifier} の webhook 自動処理に失敗しました。`, result.reply ?? result.reason].filter(Boolean).join("\n\n");

    const postedReply = await sendSlackReply(webClient, {
      channel: currentPolicy.controlRoomChannelId,
      reply: notificationReply,
      linearWorkspace: config.linearWorkspace,
    });
    await appendThreadLog(paths, {
      type: "assistant",
      ts: `${Date.now() / 1000}`,
      threadTs: `webhook:${issue.identifier}`,
      text: postedReply,
    });
  };

  logger.info("Slack assistant starting", {
    assistantName: managerPolicy.assistantName,
    channels: Array.from(config.slackAllowedChannelIds),
    model: config.botModel,
    linearWorkspace: config.linearWorkspace,
    linearTeamKey: config.linearTeamKey,
    webhookEnabled: webhookListenerEnabled,
    webhookPort: config.linearWebhookPort,
    webhookPath: config.linearWebhookPath,
    webhookLabel: LINEAR_ISSUE_CREATED_WEBHOOK_LABEL,
    ensuredWebhookId,
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
    const pendingReplyTsPromise = postSlackProcessingNotice(webClient, {
      channel: message.channelId,
      threadTs: message.rootThreadTs,
    }).catch((error) => {
      logger.warn("Failed to post Slack processing notice", {
        channelId: message.channelId,
        threadTs: message.rootThreadTs,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });

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
        const pendingReplyTs = await pendingReplyTsPromise;

        const formattedReply = await sendSlackReply(webClient, {
          channel: message.channelId,
          threadTs: message.rootThreadTs,
          reply,
          linearWorkspace: config.linearWorkspace,
          updateTs: pendingReplyTs,
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
        const pendingReplyTs = await pendingReplyTsPromise;

        const reply = await sendSlackReply(webClient, {
          channel: message.channelId,
          threadTs: message.rootThreadTs,
          reply: `処理に失敗しました。設定や Linear 連携を確認してください。\n\n${errorMessage}`,
          linearWorkspace: config.linearWorkspace,
          updateTs: pendingReplyTs,
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

  const webhookServer = webhookListenerEnabled
    ? createServer(async (request, response) => {
      if ((request.url ?? "") !== config.linearWebhookPath) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      if (request.method !== "POST") {
        response.statusCode = 405;
        response.end("Method not allowed");
        return;
      }

      const rawBody = await readRawBody(request);
      const verification = verifyLinearWebhookRequest({
        headers: request.headers,
        rawBody,
        secret: config.linearWebhookSecret ?? "",
      });
      if (!verification.ok) {
        response.statusCode = verification.statusCode;
        response.end(verification.error ?? "Invalid webhook");
        return;
      }

      const receivedAt = new Date().toISOString();
      let parsedEvent;
      try {
        parsedEvent = parseLinearWebhookEvent({
          headers: request.headers,
          rawBody,
          receivedAt,
        });
      } catch (error) {
        response.statusCode = 400;
        response.end(error instanceof Error ? error.message : String(error));
        return;
      }

      if (parsedEvent.kind === "unsupported") {
        const deliveries = await managerRepositories.webhookDeliveries.load();
        const nextDeliveries = upsertWebhookDelivery(deliveries, parsedEvent.record);
        await managerRepositories.webhookDeliveries.save(nextDeliveries);
        response.statusCode = 200;
        response.end("ok");
        return;
      }

      const deliveries = await managerRepositories.webhookDeliveries.load();
      if (isDuplicateWebhookDelivery(deliveries, parsedEvent.event.deliveryId)) {
        const existing = deliveries.find((entry) => entry.deliveryId === parsedEvent.event.deliveryId);
        if (existing?.status === "received") {
          const nextDeliveries = updateWebhookDeliveryStatus(deliveries, parsedEvent.event.deliveryId, {
            status: "ignored-duplicate",
            reason: "duplicate Linear-Delivery ignored while original processing is already in flight",
          });
          await managerRepositories.webhookDeliveries.save(nextDeliveries);
        }
        response.statusCode = 200;
        response.end("ok");
        return;
      }

      const receivedEntry = {
        deliveryId: parsedEvent.event.deliveryId,
        webhookId: parsedEvent.event.webhookId,
        issueId: parsedEvent.event.issueId,
        issueIdentifier: parsedEvent.event.issueIdentifier,
        receivedAt: parsedEvent.event.receivedAt,
        status: "received" as const,
        createdIssueIds: [],
      };
      await managerRepositories.webhookDeliveries.save(
        upsertWebhookDelivery(deliveries, receivedEntry),
      );

      webhookQueue.enqueue("linear-webhook", async () => {
        try {
          await processIssueCreatedWebhookDelivery(parsedEvent.event);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("Webhook issue create processing failed", {
            deliveryId: parsedEvent.event.deliveryId,
            issueId: parsedEvent.event.issueId,
            issueIdentifier: parsedEvent.event.issueIdentifier,
            error: errorMessage,
          });
          const nextDeliveries = updateWebhookDeliveryStatus(
            await managerRepositories.webhookDeliveries.load(),
            parsedEvent.event.deliveryId,
            {
              status: "failed",
              reason: errorMessage,
            },
          );
          await managerRepositories.webhookDeliveries.save(nextDeliveries);

          const currentPolicy = await managerRepositories.policy.load();
          await sendSlackReply(webClient, {
            channel: currentPolicy.controlRoomChannelId,
            reply: `${parsedEvent.event.issueIdentifier} の webhook 自動処理に失敗しました。\n\n${errorMessage}`,
            linearWorkspace: config.linearWorkspace,
          }).catch((notifyError) => {
            logger.error("Failed to notify control room about webhook failure", {
              deliveryId: parsedEvent.event.deliveryId,
              error: notifyError instanceof Error ? notifyError.message : String(notifyError),
            });
          });
        }
      });

      response.statusCode = 200;
      response.end("ok");
    })
    : undefined;

  await socketClient.start();
  logger.info("Slack assistant connected", {
    assistantName: managerPolicy.assistantName,
  });

  if (webhookServer) {
    await new Promise<void>((resolve, reject) => {
      webhookServer.once("error", reject);
      webhookServer.listen(config.linearWebhookPort, () => {
        webhookServer.off("error", reject);
        resolve();
      });
    });
    logger.info("Linear webhook listener started", {
      webhookPort: config.linearWebhookPort,
      webhookPath: config.linearWebhookPath,
      webhookLabel: LINEAR_ISSUE_CREATED_WEBHOOK_LABEL,
    });
  }

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
      const postedReply = await sendSlackReply(webClient, {
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

        const postedReply = await sendSlackReply(webClient, {
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
    webhookServer?.close();
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
