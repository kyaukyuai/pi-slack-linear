import type { Logger } from "./logger.js";
import type { SystemPaths } from "./system-workspace.js";
import { listActiveChannels, readHeartbeatInstructions } from "./system-workspace.js";

export interface HeartbeatExecutionContext {
  channelId: string;
  prompt: string;
}

export interface HeartbeatExecutionResult {
  reply: string;
  status: "posted" | "noop";
  reason?: "outside-business-hours" | "no-active-channels" | "no-urgent-items" | "suppressed-by-cooldown";
}

export interface HeartbeatServiceOptions {
  logger: Logger;
  workspaceDir: string;
  systemPaths: SystemPaths;
  allowedChannelIds: Set<string>;
  intervalMin: number;
  activeLookbackHours: number;
  executeHeartbeat: (context: HeartbeatExecutionContext) => Promise<HeartbeatExecutionResult>;
}

export const DEFAULT_HEARTBEAT_PROMPT = [
  "You are running a periodic heartbeat for this Slack channel.",
  "Review the current Linear task situation using the available Linear tools.",
  "Return at most one issue-centric update.",
  "Only post when there is one short actionable update worth the team's attention right now.",
  "If you post, include: the issue ID, what is wrong now, and what the team should reply with in the control room.",
  "Only consider overdue, due today, blocked, or important stale work.",
  "Keep the reply short and in Japanese.",
  "If there is nothing worth broadcasting, reply with exactly HEARTBEAT_OK.",
].join("\n");

export class HeartbeatService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: HeartbeatServiceOptions) {}

  async start(): Promise<void> {
    if (this.options.intervalMin <= 0) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMin * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const instructions = (await readHeartbeatInstructions(this.options.systemPaths)) ?? DEFAULT_HEARTBEAT_PROMPT;
      const activeChannels = await listActiveChannels(
        this.options.workspaceDir,
        this.options.allowedChannelIds,
        this.options.activeLookbackHours * 60 * 60 * 1000,
      );

      if (activeChannels.length === 0) {
        this.options.logger.info("Heartbeat noop", {
          status: "noop",
          reason: "no-active-channels",
        });
        return;
      }

      for (const channelId of activeChannels) {
        try {
          const result = await this.options.executeHeartbeat({
            channelId,
            prompt: instructions,
          });

          if (result.status === "noop") {
            this.options.logger.info("Heartbeat noop", {
              channelId,
              status: "noop",
              reason: result.reason ?? "no-urgent-items",
            });
            continue;
          }

          this.options.logger.info("Heartbeat posted", {
            channelId,
            status: "posted",
          });
        } catch (error) {
          this.options.logger.error("Heartbeat failed", {
            channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
