import { z } from "zod";

const envSchema = z.object({
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_ALLOWED_CHANNEL_IDS: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_WORKSPACE: z.string().min(1),
  LINEAR_TEAM_KEY: z.string().min(1),
  BOT_MODEL: z.string().default("claude-sonnet-4-5"),
  WORKSPACE_DIR: z.string().default("/workspace"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AppConfig {
  slackAppToken: string;
  slackBotToken: string;
  slackAllowedChannelIds: Set<string>;
  anthropicApiKey?: string;
  linearApiKey: string;
  linearWorkspace: string;
  linearTeamKey: string;
  botModel: string;
  workspaceDir: string;
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
    botModel: parsed.BOT_MODEL,
    workspaceDir: parsed.WORKSPACE_DIR,
    logLevel: parsed.LOG_LEVEL,
  };
}
