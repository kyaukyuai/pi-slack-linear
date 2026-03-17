import type { Logger } from "./logger.js";
import type { SystemPaths } from "./system-workspace.js";
import { listActiveChannels, readHeartbeatInstructions } from "./system-workspace.js";

export interface HeartbeatExecutionContext {
  channelId: string;
  prompt: string;
}

export interface HeartbeatExecutionResult {
  reply: string;
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

const DEFAULT_HEARTBEAT_PROMPT = [
  "You are running a periodic heartbeat for this Slack channel.",
  "Review the current Linear task situation using the available Linear tools.",
  "If there is one short, actionable update that the team should see now, return it in Japanese.",
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

      for (const channelId of activeChannels) {
        try {
          const result = await this.options.executeHeartbeat({
            channelId,
            prompt: instructions,
          });

          if (result.reply.trim() === "HEARTBEAT_OK") {
            continue;
          }
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
