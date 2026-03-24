import { resolve } from "node:path";
import { buildManagerIssueDiagnostics, buildManagerThreadDiagnostics } from "../src/lib/manager-diagnostics.js";
import type { AppConfig } from "../src/lib/config.js";
import { ensureManagerStateFiles, loadWebhookDeliveries } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

type Command = "thread" | "issue" | "webhook";

function parseCommand(value: string | undefined): Command {
  if (value === "thread" || value === "issue" || value === "webhook") return value;
  throw new Error("Usage: tsx scripts/manager-diagnostics.ts <thread|issue|webhook> <arg1> <arg2?> [workspaceDir]");
}

function buildRuntimeConfig(workspaceDir: string): AppConfig {
  return {
    slackAppToken: process.env.SLACK_APP_TOKEN ?? "diagnostics",
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? "diagnostics",
    slackAllowedChannelIds: new Set(
      (process.env.SLACK_ALLOWED_CHANNEL_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    linearApiKey: process.env.LINEAR_API_KEY ?? "",
    linearWorkspace: process.env.LINEAR_WORKSPACE ?? "",
    linearTeamKey: process.env.LINEAR_TEAM_KEY ?? "",
    notionApiToken: process.env.NOTION_API_TOKEN,
    notionAgendaParentPageId: process.env.NOTION_AGENDA_PARENT_PAGE_ID,
    botModel: process.env.BOT_MODEL ?? "claude-sonnet-4-5",
    workspaceDir,
    linearWebhookEnabled: process.env.LINEAR_WEBHOOK_ENABLED === "true",
    linearWebhookPublicUrl: process.env.LINEAR_WEBHOOK_PUBLIC_URL,
    linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
    linearWebhookPort: Number(process.env.LINEAR_WEBHOOK_PORT ?? 8787),
    linearWebhookPath: process.env.LINEAR_WEBHOOK_PATH ?? "/hooks/linear",
    heartbeatIntervalMin: Number(process.env.HEARTBEAT_INTERVAL_MIN ?? 30),
    heartbeatActiveLookbackHours: Number(process.env.HEARTBEAT_ACTIVE_LOOKBACK_HOURS ?? 24),
    schedulerPollSec: Number(process.env.SCHEDULER_POLL_SEC ?? 30),
    workgraphMaintenanceIntervalMin: Number(process.env.WORKGRAPH_MAINTENANCE_INTERVAL_MIN ?? 15),
    workgraphHealthWarnActiveEvents: Number(process.env.WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS ?? 200),
    workgraphAutoCompactMaxActiveEvents: Number(process.env.WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS ?? 500),
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"] | undefined) ?? "info",
  };
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const workspaceDir = resolve(
    command === "thread"
      ? process.argv[5] ?? process.env.WORKSPACE_DIR ?? "./workspace"
      : process.argv[4] ?? process.env.WORKSPACE_DIR ?? "./workspace",
  );
  const config = buildRuntimeConfig(workspaceDir);
  const systemPaths = buildSystemPaths(workspaceDir);
  await ensureManagerStateFiles(systemPaths);
  const repositories = createFileBackedManagerRepositories(systemPaths);

  if (command === "thread") {
    const channelId = process.argv[3];
    const rootThreadTs = process.argv[4];
    if (!channelId || !rootThreadTs) {
      throw new Error("Usage: tsx scripts/manager-diagnostics.ts thread <channelId> <rootThreadTs> [workspaceDir]");
    }
    const diagnostics = await buildManagerThreadDiagnostics({
      config,
      repositories,
      channelId,
      rootThreadTs,
    });
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return;
  }

  if (command === "webhook") {
    const deliveries = await loadWebhookDeliveries(systemPaths);
    process.stdout.write(`${JSON.stringify(deliveries.slice(-20), null, 2)}\n`);
    return;
  }

  const issueId = process.argv[3];
  if (!issueId) {
    throw new Error("Usage: tsx scripts/manager-diagnostics.ts issue <issueId> [workspaceDir]");
  }
  const diagnostics = await buildManagerIssueDiagnostics({
    config,
    repositories,
    issueId,
    env: {
      ...process.env,
      LINEAR_API_KEY: config.linearApiKey,
      LINEAR_WORKSPACE: config.linearWorkspace,
      LINEAR_TEAM_KEY: config.linearTeamKey,
    },
  });
  process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
