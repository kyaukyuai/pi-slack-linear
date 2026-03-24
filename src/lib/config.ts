import { z } from "zod";

const booleanishSchema = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_ALLOWED_CHANNEL_IDS: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_WORKSPACE: z.string().min(1),
  LINEAR_TEAM_KEY: z.string().min(1),
  NOTION_API_TOKEN: z.string().min(1).optional(),
  NOTION_AGENDA_PARENT_PAGE_ID: z.string().min(1).optional(),
  BOT_MODEL: z.string().default("claude-sonnet-4-5"),
  WORKSPACE_DIR: z.string().default("/workspace"),
  LINEAR_WEBHOOK_ENABLED: booleanishSchema.default(false),
  LINEAR_WEBHOOK_PUBLIC_URL: z.string().url().optional(),
  LINEAR_WEBHOOK_SECRET: z.string().min(1).optional(),
  LINEAR_WEBHOOK_PORT: z.coerce.number().int().positive().default(8787),
  LINEAR_WEBHOOK_PATH: z.string().min(1).default("/hooks/linear"),
  HEARTBEAT_INTERVAL_MIN: z.coerce.number().int().min(0).default(30),
  HEARTBEAT_ACTIVE_LOOKBACK_HOURS: z.coerce.number().int().positive().default(24),
  SCHEDULER_POLL_SEC: z.coerce.number().int().positive().default(30),
  WORKGRAPH_MAINTENANCE_INTERVAL_MIN: z.coerce.number().int().min(0).default(15),
  WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS: z.coerce.number().int().nonnegative().default(200),
  WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS: z.coerce.number().int().positive().default(500),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine((value, ctx) => {
  if (value.LINEAR_WEBHOOK_ENABLED) {
    if (!value.LINEAR_WEBHOOK_PUBLIC_URL?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LINEAR_WEBHOOK_PUBLIC_URL"],
        message: "LINEAR_WEBHOOK_PUBLIC_URL is required when LINEAR_WEBHOOK_ENABLED=true",
      });
    }
    if (!value.LINEAR_WEBHOOK_SECRET?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LINEAR_WEBHOOK_SECRET"],
        message: "LINEAR_WEBHOOK_SECRET is required when LINEAR_WEBHOOK_ENABLED=true",
      });
    }
  }

  if (!value.LINEAR_WEBHOOK_PATH.startsWith("/")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["LINEAR_WEBHOOK_PATH"],
      message: "LINEAR_WEBHOOK_PATH must start with /",
    });
  }
});

export interface AppConfig {
  slackAppToken: string;
  slackBotToken: string;
  slackAllowedChannelIds: Set<string>;
  anthropicApiKey?: string;
  linearApiKey: string;
  linearWorkspace: string;
  linearTeamKey: string;
  notionApiToken?: string;
  notionAgendaParentPageId?: string;
  botModel: string;
  workspaceDir: string;
  linearWebhookEnabled: boolean;
  linearWebhookPublicUrl?: string;
  linearWebhookSecret?: string;
  linearWebhookPort: number;
  linearWebhookPath: string;
  heartbeatIntervalMin: number;
  heartbeatActiveLookbackHours: number;
  schedulerPollSec: number;
  workgraphMaintenanceIntervalMin: number;
  workgraphHealthWarnActiveEvents: number;
  workgraphAutoCompactMaxActiveEvents: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    slackAppToken: parsed.SLACK_APP_TOKEN,
    slackBotToken: parsed.SLACK_BOT_TOKEN,
    slackAllowedChannelIds: new Set(
      parsed.SLACK_ALLOWED_CHANNEL_IDS.split(",").map((value) => value.trim()).filter(Boolean),
    ),
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    linearApiKey: parsed.LINEAR_API_KEY,
    linearWorkspace: parsed.LINEAR_WORKSPACE,
    linearTeamKey: parsed.LINEAR_TEAM_KEY,
    notionApiToken: parsed.NOTION_API_TOKEN,
    notionAgendaParentPageId: parsed.NOTION_AGENDA_PARENT_PAGE_ID,
    botModel: parsed.BOT_MODEL,
    workspaceDir: parsed.WORKSPACE_DIR,
    linearWebhookEnabled: parsed.LINEAR_WEBHOOK_ENABLED,
    linearWebhookPublicUrl: parsed.LINEAR_WEBHOOK_PUBLIC_URL,
    linearWebhookSecret: parsed.LINEAR_WEBHOOK_SECRET,
    linearWebhookPort: parsed.LINEAR_WEBHOOK_PORT,
    linearWebhookPath: parsed.LINEAR_WEBHOOK_PATH,
    heartbeatIntervalMin: parsed.HEARTBEAT_INTERVAL_MIN,
    heartbeatActiveLookbackHours: parsed.HEARTBEAT_ACTIVE_LOOKBACK_HOURS,
    schedulerPollSec: parsed.SCHEDULER_POLL_SEC,
    workgraphMaintenanceIntervalMin: parsed.WORKGRAPH_MAINTENANCE_INTERVAL_MIN,
    workgraphHealthWarnActiveEvents: parsed.WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS,
    workgraphAutoCompactMaxActiveEvents: parsed.WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS,
    logLevel: parsed.LOG_LEVEL,
  };
}
