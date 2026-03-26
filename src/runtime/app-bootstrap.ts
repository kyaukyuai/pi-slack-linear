import { createServer } from "node:http";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "../lib/config.js";
import { HeartbeatService } from "../lib/heartbeat.js";
import { ensureLinearIssueCreatedWebhook, verifyLinearCli } from "../lib/linear.js";
import { LINEAR_ISSUE_CREATED_WEBHOOK_LABEL } from "../lib/linear-webhook.js";
import { Logger } from "../lib/logger.js";
import { ensureManagerStateFiles } from "../lib/manager-state.js";
import { analyzeOwnerMap } from "../lib/owner-map-diagnostics.js";
import { disposeAllThreadRuntimes, disposeIdleThreadRuntimes } from "../lib/pi-session.js";
import { SchedulerService } from "../lib/scheduler.js";
import { loadExecutableSchedulerJobs } from "../lib/scheduler-management.js";
import { buildSystemPaths, ensureSystemWorkspace, saveSchedulerJobStatusesFromJobs } from "../lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { runWorkgraphMaintenance } from "../state/workgraph/maintenance.js";
import { createAppRuntimeHandlers } from "./app-runtime.js";
import { buildLlmDiagnosticsFromConfig } from "./llm-runtime-config.js";

export async function runApp(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
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
  const llmDiagnostics = await buildLlmDiagnosticsFromConfig(config);
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
  logger.info("LLM runtime config", {
    configuredModel: llmDiagnostics.configured.model,
    resolvedProvider: llmDiagnostics.resolvedModel.provider,
    resolvedModel: llmDiagnostics.resolvedModel.modelId,
    thinkingLevel: llmDiagnostics.effective.thread.thinkingLevel,
    configuredMaxOutputTokens: llmDiagnostics.configured.maxOutputTokens,
    retryMaxRetries: llmDiagnostics.configured.retryMaxRetries,
    contextWindow: llmDiagnostics.resolvedModel.contextWindow,
    modelMaxTokens: llmDiagnostics.resolvedModel.maxTokens,
    authSource: llmDiagnostics.authSource.source,
  });

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

  const linearEnv = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
  let heartbeatService: HeartbeatService | undefined;
  const runtimeHandlers = createAppRuntimeHandlers({
    config,
    logger,
    webClient,
    systemPaths,
    managerRepositories,
    linearEnv,
    getManagerPolicy: () => managerPolicy,
    setManagerPolicy: (nextPolicy) => {
      managerPolicy = nextPolicy;
    },
  });

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
    await runtimeHandlers.handleSlackMessageEvent(event, botUserId, heartbeatService);
  });

  const webhookServer = webhookListenerEnabled
    ? createServer(async (request, response) => {
      await runtimeHandlers.handleWebhookRequest(request, response);
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
    executeHeartbeat: runtimeHandlers.executeHeartbeat,
  });
  await heartbeatService.start();

  const schedulerService = new SchedulerService({
    logger,
    pollSec: config.schedulerPollSec,
    loadJobs: async () => loadExecutableSchedulerJobs(
      systemPaths,
      await managerRepositories.policy.load(),
    ),
    persistJobs: async (jobs) => {
      await saveSchedulerJobStatusesFromJobs(systemPaths, jobs);
    },
    executeJob: runtimeHandlers.executeScheduledJob,
  });
  await schedulerService.start();

  const shutdown = async (signal: string) => {
    logger.info("Shutting down", { signal });
    clearInterval(cleanupTimer);
    heartbeatService?.stop();
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
