import { resolve } from "node:path";
import { buildManagerIssueDiagnostics, buildManagerThreadDiagnostics } from "../src/lib/manager-diagnostics.js";
import type { AppConfig } from "../src/lib/config.js";
import { ensureManagerStateFiles, loadWebhookDeliveries } from "../src/lib/manager-state.js";
import { buildLlmDiagnosticsFromConfig } from "../src/runtime/llm-runtime-config.js";
import { buildSystemPaths, readWorkspaceAgents, readWorkspaceMemory } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

type Command = "thread" | "issue" | "webhook" | "personalization" | "llm";

function extractMarkdownHeadings(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(##|###|####)\s+/.test(line));
}

function parseCommand(value: string | undefined): Command {
  if (value === "thread" || value === "issue" || value === "webhook" || value === "personalization" || value === "llm") return value;
  throw new Error("Usage: tsx scripts/manager-diagnostics.ts <thread|issue|webhook|personalization|llm> <arg1> <arg2?> [workspaceDir]");
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
    botThinkingLevel: (process.env.BOT_THINKING_LEVEL as AppConfig["botThinkingLevel"] | undefined) ?? "minimal",
    botMaxOutputTokens: process.env.BOT_MAX_OUTPUT_TOKENS ? Number(process.env.BOT_MAX_OUTPUT_TOKENS) : undefined,
    botRetryMaxRetries: Number(process.env.BOT_RETRY_MAX_RETRIES ?? 1),
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
      : command === "issue"
        ? process.argv[4] ?? process.env.WORKSPACE_DIR ?? "./workspace"
        : process.argv[3] ?? process.env.WORKSPACE_DIR ?? "./workspace",
  );
  const config = buildRuntimeConfig(workspaceDir);
  const systemPaths = buildSystemPaths(workspaceDir);
  await ensureManagerStateFiles(systemPaths);
  const repositories = createFileBackedManagerRepositories(systemPaths);

  if (command === "llm") {
    const diagnostics = await buildLlmDiagnosticsFromConfig(config);
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
    return;
  }

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

  if (command === "personalization") {
    const [ledger, workspaceAgents, workspaceMemory] = await Promise.all([
      repositories.personalization.load(),
      readWorkspaceAgents(systemPaths),
      readWorkspaceMemory(systemPaths),
    ]);
    process.stdout.write(`${JSON.stringify({
      recentEntries: ledger.slice(-20),
      workspaceMemoryHeadings: extractMarkdownHeadings(workspaceMemory),
      workspaceMemoryProjects: extractMarkdownHeadings(workspaceMemory)
        .filter((line) => line.startsWith("### "))
        .map((line) => line.replace(/^###\s+/, "")),
      workspaceAgents,
      workspaceMemory,
    }, null, 2)}\n`);
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
