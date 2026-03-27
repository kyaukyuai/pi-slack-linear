import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { HeartbeatService, parseHeartbeatManagerReply } from "../lib/heartbeat.js";
import type { HeartbeatExecutionResult } from "../lib/heartbeat.js";
import { getLinearIssue } from "../lib/linear.js";
import {
  isDuplicateWebhookDelivery,
  isLoopedWebhookIssue,
  parseLinearWebhookEvent,
  updateWebhookDeliveryStatus,
  upsertWebhookDelivery,
  verifyLinearWebhookRequest,
} from "../lib/linear-webhook.js";
import type { Logger } from "../lib/logger.js";
import { handleManagerMessage } from "../lib/manager.js";
import { commitManagerCommandProposals, type ManagerIntentReport } from "../lib/manager-command-commit.js";
import { buildSlackVisibleLlmFailureNotice } from "../lib/llm-failure.js";
import { handleIssueCreatedWebhook } from "../orchestrators/webhooks/handle-issue-created.js";
import { handlePersonalizationUpdate } from "../orchestrators/personalization/handle-personalization.js";
import { reconcileAwaitingFollowupsWithCurrentLinear } from "../orchestrators/review/review-data.js";
import { runManagerSystemTurn } from "../lib/pi-session.js";
import {
  createSlackReplyStreamController,
  postSlackMentionMessage,
  sendSlackReply,
} from "../lib/slack-replies.js";
import { mergeSystemReply } from "../lib/system-slack-reply.js";
import { isProcessableSlackMessage, normalizeSlackMessage, type RawSlackMessageEvent } from "../lib/slack.js";
import {
  buildHeartbeatPaths,
  buildSchedulerPaths,
  buildWebhookPaths,
  type SchedulerJob,
  type SystemPaths,
} from "../lib/system-workspace.js";
import {
  appendThreadLog,
  buildThreadPaths,
  ensureThreadWorkspace,
  type AttachmentRecord,
  type ThreadPaths,
} from "../lib/thread-workspace.js";
import type { AppConfig } from "../lib/config.js";
import type { SchedulerExecutionResult } from "../lib/scheduler.js";
import type { ManagerPolicy } from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";

export class ThreadQueue {
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

function buildSlackVisibleFailureReply(args: {
  error: unknown;
  fallbackReply: string;
  includeTechnicalMessage?: boolean;
}): string {
  const llmFailureNotice = buildSlackVisibleLlmFailureNotice(args.error);
  if (llmFailureNotice) {
    return [llmFailureNotice, args.fallbackReply].filter(Boolean).join("\n\n");
  }

  if (!args.includeTechnicalMessage) {
    return args.fallbackReply;
  }

  const technicalMessage = args.error instanceof Error ? args.error.message : String(args.error);
  return [args.fallbackReply, technicalMessage].filter(Boolean).join("\n\n");
}

function isReadOnlyStreamingIntent(
  intent: ManagerIntentReport["intent"] | undefined,
): intent is "conversation" | "query" | "query_schedule" {
  return intent === "conversation" || intent === "query" || intent === "query_schedule";
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

function createJstClock(): {
  currentDateInJst: () => string;
  currentDateTimeInJst: () => string;
} {
  return {
    currentDateInJst: () => new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    currentDateTimeInJst: () => {
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
    },
  };
}

export interface AppRuntimeHandlers {
  handleSlackMessageEvent: (event: unknown, botUserId: string, heartbeatService?: HeartbeatService) => Promise<void>;
  handleWebhookRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  executeHeartbeat: (args: { channelId: string; prompt: string }) => Promise<HeartbeatExecutionResult>;
  executeScheduledJob: (args: { job: SchedulerJob }) => Promise<SchedulerExecutionResult>;
}

export function createAppRuntimeHandlers(args: {
  config: AppConfig;
  logger: Logger;
  webClient: WebClient;
  systemPaths: SystemPaths;
  managerRepositories: ManagerRepositories;
  linearEnv: Record<string, string | undefined>;
  slackTeamId?: string;
  getManagerPolicy: () => ManagerPolicy;
  setManagerPolicy: (policy: ManagerPolicy) => void;
}): AppRuntimeHandlers {
  const { currentDateInJst, currentDateTimeInJst } = createJstClock();
  const messageQueue = new ThreadQueue();
  const webhookQueue = new ThreadQueue();

  async function executeManagerSystemTask(task: {
    paths: ThreadPaths;
    input: Parameters<typeof runManagerSystemTurn>[2];
    fallback: () => Promise<string>;
  }): Promise<string> {
    try {
      if (
        task.input.kind === "heartbeat"
        || task.input.kind === "morning-review"
        || task.input.kind === "evening-review"
        || task.input.kind === "weekly-review"
      ) {
        try {
          await reconcileAwaitingFollowupsWithCurrentLinear(args.config, args.managerRepositories, new Date());
        } catch (error) {
          args.logger.warn("Review followup reconcile failed before manager system task", {
            kind: task.input.kind,
            channelId: task.input.channelId,
            threadTs: task.input.rootThreadTs,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const agentResult = await runManagerSystemTurn(args.config, task.paths, task.input);
      const commitResult = await commitManagerCommandProposals({
        config: args.config,
        repositories: args.managerRepositories,
        proposals: agentResult.proposals,
        message: {
          channelId: task.input.channelId,
          rootThreadTs: task.input.rootThreadTs,
          messageTs: task.input.messageTs,
          text: task.input.text,
        },
        now: new Date(),
        policy: args.getManagerPolicy(),
        env: args.linearEnv,
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
              persistedSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
              commitSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
            };
          }
        },
      });
      args.logger.info("Manager system agent result", {
        intent: agentResult.intentReport?.intent,
        queryKind: agentResult.intentReport?.queryKind,
        queryScope: agentResult.intentReport?.queryScope,
        toolCalls: agentResult.toolCalls.map((call) => call.toolName),
        proposalCount: agentResult.proposals.length,
        invalidProposalCount: agentResult.invalidProposalCount,
        committedCommands: commitResult.committed.map((entry) => entry.commandType),
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
        channelId: task.input.channelId,
        threadTs: task.input.rootThreadTs,
      });
      const mergedReply = mergeSystemReply({
        agentReply: agentResult.reply,
        commitSummaries: commitResult.replySummaries,
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
      });
      try {
        await handlePersonalizationUpdate({
          config: args.config,
          systemPaths: args.systemPaths,
          paths: task.paths,
          repositories: args.managerRepositories,
          turnKind: "manager-system",
          latestUserMessage: task.input.text,
          latestAssistantReply: mergedReply,
          committedCommands: commitResult.committed.map((entry) => entry.commandType),
          rejectedReasons: commitResult.rejected.map((entry) => entry.reason),
          currentDate: task.input.currentDate,
          issueContext: {
            issueId: task.input.metadata?.issueId,
            issueIdentifier: task.input.metadata?.issueIdentifier,
          },
          now: new Date(),
        });
      } catch (error) {
        args.logger.warn("Personalization update failed after manager system task", {
          channelId: task.input.channelId,
          threadTs: task.input.rootThreadTs,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return mergedReply;
    } catch (error) {
      args.logger.warn("Manager system agent fell back to safety-only response", {
        channelId: task.input.channelId,
        threadTs: task.input.rootThreadTs,
        error: error instanceof Error ? error.message : String(error),
      });
      return buildSlackVisibleFailureReply({
        error,
        fallbackReply: await task.fallback(),
      });
    }
  }

  async function executeCustomSchedulerJob(
    job: SchedulerJob,
    trigger: "scheduled" | "manual",
  ): Promise<{
    postedReply: string;
    rawReply: string;
    commitSummary?: string;
  }> {
    const paths = buildSchedulerPaths(args.config.workspaceDir, job.id);
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

    const postedReply = await sendSlackReply(args.webClient, {
      channel: job.channelId,
      reply: rawReply,
      linearWorkspace: args.config.linearWorkspace,
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
  }

  async function executeSlackMentionPost(argsForPost: {
    channel: string;
    mentionSlackUserId: string;
    messageText: string;
    threadTs?: string;
  }): Promise<{ text: string; ts?: string }> {
    return postSlackMentionMessage(args.webClient, {
      channel: argsForPost.channel,
      mentionSlackUserId: argsForPost.mentionSlackUserId,
      messageText: argsForPost.messageText,
      threadTs: argsForPost.threadTs,
      linearWorkspace: args.config.linearWorkspace,
    });
  }

  async function processIssueCreatedWebhookDelivery(event: {
    deliveryId: string;
    webhookId?: string;
    issueId: string;
    issueIdentifier: string;
    receivedAt: string;
  }): Promise<void> {
    const currentPolicy = await args.managerRepositories.policy.load();
    const deliveries = await args.managerRepositories.webhookDeliveries.load();
    if (isLoopedWebhookIssue(deliveries, event.issueId, event.issueIdentifier)) {
      const nextDeliveries = updateWebhookDeliveryStatus(deliveries, event.deliveryId, {
        status: "ignored-loop",
        reason: `${event.issueIdentifier} was created by prior webhook automation`,
      });
      await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
      args.logger.info("Ignored webhook issue create due to loop prevention", {
        deliveryId: event.deliveryId,
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
      });
      return;
    }

    const issue = await getLinearIssue(event.issueIdentifier, args.linearEnv).catch(async () => {
      return getLinearIssue(event.issueId, args.linearEnv);
    });
    if (!issue.identifier.startsWith(`${args.config.linearTeamKey}-`)) {
      const nextDeliveries = updateWebhookDeliveryStatus(deliveries, event.deliveryId, {
        status: "ignored-unsupported",
        reason: `${issue.identifier} is outside team ${args.config.linearTeamKey}`,
      });
      await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
      args.logger.info("Ignored webhook issue create outside configured team", {
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
      });
      return;
    }

    const paths = buildWebhookPaths(args.config.workspaceDir, issue.identifier);
    await ensureThreadWorkspace(paths);
    await appendThreadLog(paths, {
      type: "system",
      ts: `${Date.now() / 1000}`,
      threadTs: `webhook:${issue.identifier}`,
      text: `linear webhook issue created: ${issue.identifier}`,
    });

    const result = await handleIssueCreatedWebhook({
      config: args.config,
      paths,
      repositories: args.managerRepositories,
      policy: currentPolicy,
      issue,
      deliveryId: event.deliveryId,
      webhookId: event.webhookId,
      now: new Date(),
      env: args.linearEnv,
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
            persistedSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
            commitSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
          };
        }
      },
    });

    const nextDeliveries = updateWebhookDeliveryStatus(
      await args.managerRepositories.webhookDeliveries.load(),
      event.deliveryId,
      {
        status: result.status,
        reason: result.reason,
        createdIssueIds: result.createdIssueIds,
      },
    );
    await args.managerRepositories.webhookDeliveries.save(nextDeliveries);

    if (result.agentResult) {
      args.logger.info("Manager webhook agent result", {
        intent: result.agentResult.intentReport?.intent,
        queryKind: result.agentResult.intentReport?.queryKind,
        queryScope: result.agentResult.intentReport?.queryScope,
        taskExecutionDecision: result.agentResult.taskExecutionDecision?.decision,
        taskExecutionSummary: result.agentResult.taskExecutionDecision?.summary,
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
      args.logger.info("Webhook issue create resulted in no-op", {
        deliveryId: event.deliveryId,
        issueIdentifier: issue.identifier,
        reason: result.reason,
      });
      return;
    }

    const notificationReply = result.status === "committed"
      ? [`${issue.identifier} に対して自動処理を実施しました。`, result.reply].filter(Boolean).join("\n\n")
      : [`${issue.identifier} の webhook 自動処理に失敗しました。`, result.reply ?? result.reason].filter(Boolean).join("\n\n");

    const postedReply = await sendSlackReply(args.webClient, {
      channel: currentPolicy.controlRoomChannelId,
      reply: notificationReply,
      linearWorkspace: args.config.linearWorkspace,
    });
    await appendThreadLog(paths, {
      type: "assistant",
      ts: `${Date.now() / 1000}`,
      threadTs: `webhook:${issue.identifier}`,
      text: postedReply,
    });
  }

  async function handleSlackMessageEvent(
    event: unknown,
    botUserId: string,
    heartbeatService?: HeartbeatService,
  ): Promise<void> {
    const rawEvent = event as RawSlackMessageEvent;
    if (!isProcessableSlackMessage(rawEvent, botUserId, args.config.slackAllowedChannelIds)) {
      return;
    }

    const message = normalizeSlackMessage(rawEvent);
    const threadKey = `${message.channelId}:${message.rootThreadTs}`;
    let observedIntent: ManagerIntentReport["intent"] | undefined;
    let streamActivationPromise: Promise<boolean> | undefined;
    const streamController = createSlackReplyStreamController(args.webClient, {
      channel: message.channelId,
      threadTs: message.rootThreadTs,
      recipientUserId: message.userId,
      recipientTeamId: args.slackTeamId,
      linearWorkspace: args.config.linearWorkspace,
      onEvent: (event) => {
        const logPayload = {
          channelId: message.channelId,
          threadTs: message.rootThreadTs,
          intent: observedIntent,
          reason: event.reason,
          error: event.error,
          streamTs: event.ts,
        };
        if (event.type === "stream_failed") {
          args.logger.warn("Slack reply stream failed", logPayload);
          return;
        }
        if (event.type === "stream_fallback") {
          args.logger.info("Slack reply stream fell back to non-streaming reply", logPayload);
          return;
        }
        if (event.type === "stream_started") {
          args.logger.info("Slack reply stream started", logPayload);
          return;
        }
        args.logger.info("Slack reply stream stopped", logPayload);
      },
    });

    messageQueue.enqueue(threadKey, async () => {
      const paths = buildThreadPaths(args.config.workspaceDir, message.channelId, message.rootThreadTs);
      await ensureThreadWorkspace(paths);

      let attachments: AttachmentRecord[] = [];
      try {
        attachments = await downloadAttachments(args.config.slackBotToken, paths.attachmentsDir, message.files);
      } catch (error) {
        args.logger.warn("Attachment download failed", {
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
          args.config,
          args.systemPaths,
          {
            channelId: message.channelId,
            rootThreadTs: message.rootThreadTs,
            messageTs: message.ts,
            userId: message.userId,
            text: message.text,
          },
          args.managerRepositories,
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
                  persistedSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
                  commitSummary: buildSlackVisibleLlmFailureNotice(error) ?? errorMessage,
                };
              }
            },
            postSlackMessage: executeSlackMentionPost,
            managerAgentObserver: {
              onIntentReport: (report) => {
                observedIntent = report.intent;
                if (!isReadOnlyStreamingIntent(report.intent)) {
                  streamController.disableStreaming();
                  streamActivationPromise = undefined;
                  return;
                }
                streamActivationPromise = streamController.enableStreaming().catch((error) => {
                  args.logger.warn("Failed to enable Slack reply streaming", {
                    channelId: message.channelId,
                    threadTs: message.rootThreadTs,
                    intent: report.intent,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  return false;
                });
              },
              onTextDelta: (delta) => {
                streamController.pushTextDelta(delta);
              },
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
            args.logger.warn("Manager agent fell back to safety-only response", logPayload);
          } else {
            args.logger.info("Manager agent decision", logPayload);
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
            args.logger.warn("Manager fallback routing decided a safety-only response", logPayload);
          } else {
            args.logger.info("Manager router decision", logPayload);
          }
        }

        if (heartbeatService && managerResult.diagnostics?.agent?.committedCommands.includes("update_builtin_schedule")) {
          const managerPolicy = await args.managerRepositories.policy.load();
          args.setManagerPolicy(managerPolicy);
          await heartbeatService.reconfigure({
            intervalMin: managerPolicy.heartbeatEnabled ? managerPolicy.heartbeatIntervalMin : 0,
            activeLookbackHours: managerPolicy.heartbeatActiveLookbackHours,
          });
        }

        const reply = managerResult.reply ?? "必要なことを少し具体的に教えてください。";
        if (streamActivationPromise) {
          await streamActivationPromise;
        }
        const formattedReply = await streamController.finalizeReply(reply);

        await appendThreadLog(paths, {
          type: "assistant",
          ts: `${Date.now() / 1000}`,
          threadTs: message.rootThreadTs,
          text: formattedReply,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        args.logger.error("Failed to process Slack message", {
          channelId: message.channelId,
          threadTs: message.rootThreadTs,
          error: errorMessage,
        });
        if (streamActivationPromise) {
          await streamActivationPromise;
        }
        const reply = await streamController.finalizeReply(buildSlackVisibleFailureReply({
          error,
          fallbackReply: "処理に失敗しました。設定や Linear 連携を確認してください。",
          includeTechnicalMessage: true,
        }));

        await appendThreadLog(paths, {
          type: "system",
          ts: `${Date.now() / 1000}`,
          threadTs: message.rootThreadTs,
          text: reply,
        });
      }
    });
  }

  async function handleWebhookRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if ((request.url ?? "") !== args.config.linearWebhookPath) {
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
      secret: args.config.linearWebhookSecret ?? "",
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
      const deliveries = await args.managerRepositories.webhookDeliveries.load();
      const nextDeliveries = upsertWebhookDelivery(deliveries, parsedEvent.record);
      await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
      response.statusCode = 200;
      response.end("ok");
      return;
    }

    const deliveries = await args.managerRepositories.webhookDeliveries.load();
    if (isDuplicateWebhookDelivery(deliveries, parsedEvent.event.deliveryId)) {
      const existing = deliveries.find((entry) => entry.deliveryId === parsedEvent.event.deliveryId);
      if (existing?.status === "received") {
        const nextDeliveries = updateWebhookDeliveryStatus(deliveries, parsedEvent.event.deliveryId, {
          status: "ignored-duplicate",
          reason: "duplicate Linear-Delivery ignored while original processing is already in flight",
        });
        await args.managerRepositories.webhookDeliveries.save(nextDeliveries);
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
    await args.managerRepositories.webhookDeliveries.save(
      upsertWebhookDelivery(deliveries, receivedEntry),
    );

    webhookQueue.enqueue("linear-webhook", async () => {
      try {
        await processIssueCreatedWebhookDelivery(parsedEvent.event);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        args.logger.error("Webhook issue create processing failed", {
          deliveryId: parsedEvent.event.deliveryId,
          issueId: parsedEvent.event.issueId,
          issueIdentifier: parsedEvent.event.issueIdentifier,
          error: errorMessage,
        });
        const nextDeliveries = updateWebhookDeliveryStatus(
          await args.managerRepositories.webhookDeliveries.load(),
          parsedEvent.event.deliveryId,
          {
            status: "failed",
            reason: errorMessage,
          },
        );
        await args.managerRepositories.webhookDeliveries.save(nextDeliveries);

        const currentPolicy = await args.managerRepositories.policy.load();
        await sendSlackReply(args.webClient, {
          channel: currentPolicy.controlRoomChannelId,
          reply: `${parsedEvent.event.issueIdentifier} の webhook 自動処理に失敗しました。\n\n${
            buildSlackVisibleFailureReply({
              error,
              fallbackReply: "処理に失敗しました。設定や Linear 連携を確認してください。",
              includeTechnicalMessage: true,
            })
          }`,
          linearWorkspace: args.config.linearWorkspace,
        }).catch((notifyError) => {
          args.logger.error("Failed to notify control room about webhook failure", {
            deliveryId: parsedEvent.event.deliveryId,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        });
      }
    });

    response.statusCode = 200;
    response.end("ok");
  }

  async function executeHeartbeat(argsForHeartbeat: {
    channelId: string;
    prompt: string;
  }): Promise<HeartbeatExecutionResult> {
    const paths = buildHeartbeatPaths(args.config.workspaceDir, argsForHeartbeat.channelId);
    await ensureThreadWorkspace(paths);
    await appendThreadLog(paths, {
      type: "system",
      ts: `${Date.now() / 1000}`,
      threadTs: "heartbeat",
      text: argsForHeartbeat.prompt,
    });

    const reply = await executeManagerSystemTask({
      paths,
      input: {
        kind: "heartbeat",
        channelId: argsForHeartbeat.channelId,
        rootThreadTs: "heartbeat",
        messageTs: "heartbeat",
        currentDate: currentDateInJst(),
        runAtJst: currentDateTimeInJst(),
        text: argsForHeartbeat.prompt,
      },
      fallback: async () => "heartbeat noop: agent-fallback",
    });
    const parsedHeartbeatReply = parseHeartbeatManagerReply(reply);
    if (parsedHeartbeatReply.status === "noop") {
      await appendThreadLog(paths, {
        type: "system",
        ts: `${Date.now() / 1000}`,
        threadTs: "heartbeat",
        text: parsedHeartbeatReply.reply,
      });
      return {
        reply: parsedHeartbeatReply.reply,
        status: "noop",
        reason: parsedHeartbeatReply.reason,
      };
    }

    const postedReply = await sendSlackReply(args.webClient, {
      channel: argsForHeartbeat.channelId,
      reply: parsedHeartbeatReply.reply,
      linearWorkspace: args.config.linearWorkspace,
    });

    await appendThreadLog(paths, {
      type: "assistant",
      ts: `${Date.now() / 1000}`,
      threadTs: "heartbeat",
      text: postedReply,
    });

    return { reply: postedReply, status: "posted" };
  }

  async function executeScheduledJob(
    argsForJob: { job: SchedulerJob },
  ): Promise<SchedulerExecutionResult> {
    const { job } = argsForJob;
    if (!args.config.slackAllowedChannelIds.has(job.channelId)) {
      throw new Error(`Job channel ${job.channelId} is not in SLACK_ALLOWED_CHANNEL_IDS`);
    }

    if (job.action) {
      const mappedKind = job.action;
      const paths = buildSchedulerPaths(args.config.workspaceDir, job.id);
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

      const postedReply = await sendSlackReply(args.webClient, {
        channel: job.channelId,
        reply,
        linearWorkspace: args.config.linearWorkspace,
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
  }

  return {
    handleSlackMessageEvent,
    handleWebhookRequest,
    executeHeartbeat,
    executeScheduledJob,
  };
}
