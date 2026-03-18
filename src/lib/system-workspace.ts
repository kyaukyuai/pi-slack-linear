import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ThreadPaths } from "./thread-workspace.js";

export interface SystemPaths {
  rootDir: string;
  jobsFile: string;
  heartbeatPromptFile: string;
  policyFile: string;
  ownerMapFile: string;
  intakeLedgerFile: string;
  followupsFile: string;
  planningLedgerFile: string;
  workgraphEventsFile: string;
  sessionsDir: string;
}

const schedulerJobSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    channelId: z.string().min(1),
    prompt: z.string().min(1),
    kind: z.enum(["at", "every", "daily", "weekly"]),
    at: z.string().datetime().optional(),
    everySec: z.number().int().positive().optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    weekday: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).optional(),
    action: z.enum(["morning-review", "evening-review", "weekly-review"]).optional(),
    nextRunAt: z.string().datetime().optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    lastRunAt: z.string().datetime().optional(),
    lastStatus: z.enum(["ok", "error"]).optional(),
    lastError: z.string().optional(),
    lastResult: z.string().optional(),
  })
  .superRefine((job, ctx) => {
    if (job.kind === "at" && !job.at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at is required for kind=at",
        path: ["at"],
      });
    }
    if (job.kind === "every" && !job.everySec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "everySec is required for kind=every",
        path: ["everySec"],
      });
    }
    if (job.kind === "daily" && !job.time) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "time is required for kind=daily",
        path: ["time"],
      });
    }
    if (job.kind === "weekly" && !job.time) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "time is required for kind=weekly",
        path: ["time"],
      });
    }
    if (job.kind === "weekly" && !job.weekday) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "weekday is required for kind=weekly",
        path: ["weekday"],
      });
    }
  });

const schedulerJobsSchema = z.array(schedulerJobSchema);

const DEFAULT_HEARTBEAT_INSTRUCTIONS = [
  "You are running a periodic heartbeat for this Slack channel.",
  "Review the current Linear task situation using the available Linear tools.",
  "Return at most one issue-centric update.",
  "Only post when there is one short actionable update worth the team's attention right now.",
  "If you post, include: the issue ID, what is wrong now, and what the team should reply with in the control room.",
  "Only consider overdue, due today, blocked, or important stale work.",
  "Keep the reply short and in Japanese.",
  "If there is nothing worth broadcasting, reply with exactly HEARTBEAT_OK.",
].join("\n");

export type SchedulerJob = z.infer<typeof schedulerJobSchema>;

function sanitizeSegment(value: string): string {
  return value.replace(/[^\w.-]/g, "_");
}

export function buildSystemPaths(workspaceDir: string): SystemPaths {
  const rootDir = join(workspaceDir, "system");
  return {
    rootDir,
    jobsFile: join(rootDir, "jobs.json"),
    heartbeatPromptFile: join(rootDir, "HEARTBEAT.md"),
    policyFile: join(rootDir, "policy.json"),
    ownerMapFile: join(rootDir, "owner-map.json"),
    intakeLedgerFile: join(rootDir, "intake-ledger.json"),
    followupsFile: join(rootDir, "followups.json"),
    planningLedgerFile: join(rootDir, "planning-ledger.json"),
    workgraphEventsFile: join(rootDir, "workgraph-events.jsonl"),
    sessionsDir: join(rootDir, "sessions"),
  };
}

export function buildHeartbeatPaths(workspaceDir: string, channelId: string): ThreadPaths {
  const safeChannelId = sanitizeSegment(channelId);
  const rootDir = join(workspaceDir, "system", "sessions", "heartbeat", safeChannelId);
  return {
    rootDir,
    sessionFile: join(rootDir, "session.jsonl"),
    logFile: join(rootDir, "log.jsonl"),
    attachmentsDir: join(rootDir, "attachments"),
    scratchDir: join(rootDir, "scratch"),
  };
}

export function buildSchedulerPaths(workspaceDir: string, jobId: string): ThreadPaths {
  const safeJobId = sanitizeSegment(jobId);
  const rootDir = join(workspaceDir, "system", "sessions", "cron", safeJobId);
  return {
    rootDir,
    sessionFile: join(rootDir, "session.jsonl"),
    logFile: join(rootDir, "log.jsonl"),
    attachmentsDir: join(rootDir, "attachments"),
    scratchDir: join(rootDir, "scratch"),
  };
}

export async function ensureSystemWorkspace(paths: SystemPaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
  try {
    await stat(paths.jobsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(paths.jobsFile, "[]\n", "utf8");
    } else {
      throw error;
    }
  }

  try {
    await stat(paths.heartbeatPromptFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(paths.heartbeatPromptFile, `${DEFAULT_HEARTBEAT_INSTRUCTIONS}\n`, "utf8");
    } else {
      throw error;
    }
  }
}

export async function loadSchedulerJobs(paths: SystemPaths): Promise<SchedulerJob[]> {
  try {
    const raw = await readFile(paths.jobsFile, "utf8");
    const parsed = JSON.parse(raw);
    return schedulerJobsSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await ensureSystemWorkspace(paths);
      return [];
    }
    throw error;
  }
}

export async function saveSchedulerJobs(paths: SystemPaths, jobs: SchedulerJob[]): Promise<void> {
  await writeFile(paths.jobsFile, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
}

export async function readHeartbeatInstructions(paths: SystemPaths): Promise<string | undefined> {
  try {
    const raw = await readFile(paths.heartbeatPromptFile, "utf8");
    const normalized = raw.trim();
    return normalized ? normalized : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function listActiveChannels(
  workspaceDir: string,
  channelIds: Iterable<string>,
  lookbackMs: number,
): Promise<string[]> {
  const cutoff = Date.now() - lookbackMs;
  const active: string[] = [];

  for (const channelId of channelIds) {
    const channelRoot = join(workspaceDir, "threads", channelId);
    try {
      const threadEntries = await readdir(channelRoot, { withFileTypes: true });
      let latestMtime = 0;

      for (const entry of threadEntries) {
        if (!entry.isDirectory()) continue;
        const logFile = join(channelRoot, entry.name, "log.jsonl");
        try {
          const logStats = await stat(logFile);
          latestMtime = Math.max(latestMtime, logStats.mtimeMs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      if (latestMtime >= cutoff) {
        active.push(channelId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return active;
}
