import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { stripGeneratedPersonalizationMarkers } from "./personalization-commit.js";
import type { ThreadPaths } from "./thread-workspace.js";

export interface SystemPaths {
  rootDir: string;
  jobsFile: string;
  jobStatusFile: string;
  heartbeatPromptFile: string;
  workspaceAgentsFile: string;
  memoryFile: string;
  agendaTemplateFile: string;
  notionPagesFile: string;
  policyFile: string;
  ownerMapFile: string;
  followupsFile: string;
  planningLedgerFile: string;
  personalizationLedgerFile: string;
  webhookDeliveriesFile: string;
  workgraphEventsFile: string;
  workgraphSnapshotFile: string;
  sessionsDir: string;
}

export interface WorkspaceCustomizationContext {
  workspaceAgents?: string;
  workspaceMemory?: string;
  agendaTemplate?: string;
}

export type SystemStateFileClassification = "editable" | "internal" | "derived";
export type SystemStateOperatorAction = "edit-ok" | "inspect-only" | "do-not-edit";
export type SystemStateEntryType = "file" | "directory";
export type SystemStateWritePolicy =
  | "human-primary"
  | "silent-auto-update"
  | "explicit-slack-update"
  | "manager-commit-only"
  | "system-maintained"
  | "rebuild-only";

export interface SystemStateFileDefinition {
  pathKey: keyof SystemPaths;
  relativePath: string;
  entryType: SystemStateEntryType;
  classification: SystemStateFileClassification;
  operatorAction: SystemStateOperatorAction;
  writePolicy: SystemStateWritePolicy;
  purpose: string;
}

export interface SystemStateFileDescriptor extends SystemStateFileDefinition {
  absolutePath: string;
}

export interface SystemStateFileStatus extends SystemStateFileDescriptor {
  exists: boolean;
  sizeBytes: number | null;
  lastModifiedAt?: string;
}

const schedulerJobRuntimeStateShape = {
  nextRunAt: z.string().datetime().optional(),
  lastRunAt: z.string().datetime().optional(),
  lastStatus: z.enum(["ok", "error"]).optional(),
  lastError: z.string().optional(),
  lastResult: z.string().optional(),
} as const;

const schedulerJobConfigShape = {
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
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
} as const;

function validateSchedulerJobShape(
  job: z.infer<z.ZodObject<typeof schedulerJobConfigShape>>,
  ctx: z.RefinementCtx,
): void {
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
}

export const schedulerJobConfigSchema = z
  .object(schedulerJobConfigShape)
  .superRefine(validateSchedulerJobShape);

export const schedulerJobStatusSchema = z.object({
  id: z.string().min(1),
  ...schedulerJobRuntimeStateShape,
});

export const schedulerJobSchema = z
  .object({
    ...schedulerJobConfigShape,
    ...schedulerJobRuntimeStateShape,
  })
  .superRefine(validateSchedulerJobShape);
export const schedulerJobConfigsSchema = z.array(schedulerJobConfigSchema);
export const schedulerJobStatusesSchema = z.array(schedulerJobStatusSchema);
export const schedulerJobsSchema = z.array(schedulerJobSchema);

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
export type SchedulerJobConfig = z.infer<typeof schedulerJobConfigSchema>;
export type SchedulerJobStatus = z.infer<typeof schedulerJobStatusSchema>;

export const SYSTEM_STATE_FILE_DEFINITIONS: readonly SystemStateFileDefinition[] = [
  {
    pathKey: "workspaceAgentsFile",
    relativePath: "AGENTS.md",
    entryType: "file",
    classification: "editable",
    operatorAction: "edit-ok",
    writePolicy: "silent-auto-update",
    purpose: "Shared runtime operating rules injected into manager and planner turns.",
  },
  {
    pathKey: "memoryFile",
    relativePath: "MEMORY.md",
    entryType: "file",
    classification: "editable",
    operatorAction: "edit-ok",
    writePolicy: "silent-auto-update",
    purpose: "Shared runtime project knowledge, terminology, and durable context.",
  },
  {
    pathKey: "agendaTemplateFile",
    relativePath: "AGENDA_TEMPLATE.md",
    entryType: "file",
    classification: "editable",
    operatorAction: "edit-ok",
    writePolicy: "explicit-slack-update",
    purpose: "Default Notion agenda template for agenda create and update flows.",
  },
  {
    pathKey: "heartbeatPromptFile",
    relativePath: "HEARTBEAT.md",
    entryType: "file",
    classification: "editable",
    operatorAction: "edit-ok",
    writePolicy: "explicit-slack-update",
    purpose: "Prompt override for scheduled heartbeat turns.",
  },
  {
    pathKey: "policyFile",
    relativePath: "policy.json",
    entryType: "file",
    classification: "editable",
    operatorAction: "edit-ok",
    writePolicy: "manager-commit-only",
    purpose: "Manager operating policy and built-in review or heartbeat configuration.",
  },
  {
    pathKey: "ownerMapFile",
    relativePath: "owner-map.json",
    entryType: "file",
    classification: "editable",
    operatorAction: "edit-ok",
    writePolicy: "explicit-slack-update",
    purpose: "Owner resolution map used for assignment and fallback ownership decisions.",
  },
  {
    pathKey: "jobsFile",
    relativePath: "jobs.json",
    entryType: "file",
    classification: "editable",
    operatorAction: "edit-ok",
    writePolicy: "manager-commit-only",
    purpose: "Custom scheduler job definitions managed through proposal and manager commit flows.",
  },
  {
    pathKey: "jobStatusFile",
    relativePath: "job-status.json",
    entryType: "file",
    classification: "internal",
    operatorAction: "inspect-only",
    writePolicy: "system-maintained",
    purpose: "System-maintained runtime status for custom and built-in scheduler jobs.",
  },
  {
    pathKey: "followupsFile",
    relativePath: "followups.json",
    entryType: "file",
    classification: "internal",
    operatorAction: "inspect-only",
    writePolicy: "system-maintained",
    purpose: "System-managed follow-up queue and pending response ledger.",
  },
  {
    pathKey: "planningLedgerFile",
    relativePath: "planning-ledger.json",
    entryType: "file",
    classification: "internal",
    operatorAction: "inspect-only",
    writePolicy: "system-maintained",
    purpose: "System-managed planning outcomes and dedupe history for manager turns.",
  },
  {
    pathKey: "notionPagesFile",
    relativePath: "notion-pages.json",
    entryType: "file",
    classification: "internal",
    operatorAction: "inspect-only",
    writePolicy: "system-maintained",
    purpose: "Registry of Notion pages that the manager is allowed to update or archive.",
  },
  {
    pathKey: "personalizationLedgerFile",
    relativePath: "personalization-ledger.json",
    entryType: "file",
    classification: "internal",
    operatorAction: "inspect-only",
    writePolicy: "system-maintained",
    purpose: "Observed personalization candidates before they are promoted into runtime customization.",
  },
  {
    pathKey: "webhookDeliveriesFile",
    relativePath: "webhook-deliveries.json",
    entryType: "file",
    classification: "internal",
    operatorAction: "inspect-only",
    writePolicy: "system-maintained",
    purpose: "System ledger of webhook deliveries, loop prevention, and reconcile results.",
  },
  {
    pathKey: "workgraphEventsFile",
    relativePath: "workgraph-events.jsonl",
    entryType: "file",
    classification: "derived",
    operatorAction: "do-not-edit",
    writePolicy: "rebuild-only",
    purpose: "Append-only workgraph event log derived from manager execution.",
  },
  {
    pathKey: "workgraphSnapshotFile",
    relativePath: "workgraph-snapshot.json",
    entryType: "file",
    classification: "derived",
    operatorAction: "do-not-edit",
    writePolicy: "rebuild-only",
    purpose: "Derived workgraph snapshot rebuilt from the event log or compaction.",
  },
  {
    pathKey: "sessionsDir",
    relativePath: "sessions/",
    entryType: "directory",
    classification: "derived",
    operatorAction: "do-not-edit",
    writePolicy: "rebuild-only",
    purpose: "Derived isolated session state for heartbeat, scheduler, and webhook runs.",
  },
] as const;

function sanitizeSegment(value: string): string {
  return value.replace(/[^\w.-]/g, "_");
}

export function buildSystemPaths(workspaceDir: string): SystemPaths {
  const rootDir = join(workspaceDir, "system");
  return {
    rootDir,
    jobsFile: join(rootDir, "jobs.json"),
    jobStatusFile: join(rootDir, "job-status.json"),
    heartbeatPromptFile: join(rootDir, "HEARTBEAT.md"),
    workspaceAgentsFile: join(rootDir, "AGENTS.md"),
    memoryFile: join(rootDir, "MEMORY.md"),
    agendaTemplateFile: join(rootDir, "AGENDA_TEMPLATE.md"),
    notionPagesFile: join(rootDir, "notion-pages.json"),
    policyFile: join(rootDir, "policy.json"),
    ownerMapFile: join(rootDir, "owner-map.json"),
    followupsFile: join(rootDir, "followups.json"),
    planningLedgerFile: join(rootDir, "planning-ledger.json"),
    personalizationLedgerFile: join(rootDir, "personalization-ledger.json"),
    webhookDeliveriesFile: join(rootDir, "webhook-deliveries.json"),
    workgraphEventsFile: join(rootDir, "workgraph-events.jsonl"),
    workgraphSnapshotFile: join(rootDir, "workgraph-snapshot.json"),
    sessionsDir: join(rootDir, "sessions"),
  };
}

export function listSystemStateFiles(paths: SystemPaths): SystemStateFileDescriptor[] {
  return SYSTEM_STATE_FILE_DEFINITIONS.map((definition) => ({
    ...definition,
    absolutePath: paths[definition.pathKey],
  }));
}

export async function inspectSystemStateFiles(paths: SystemPaths): Promise<SystemStateFileStatus[]> {
  return Promise.all(listSystemStateFiles(paths).map(async (definition) => {
    try {
      const stats = await stat(definition.absolutePath);
      return {
        ...definition,
        exists: true,
        sizeBytes: stats.size,
        lastModifiedAt: stats.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ...definition,
          exists: false,
          sizeBytes: null,
        };
      }
      throw error;
    }
  }));
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

export function buildWebhookPaths(workspaceDir: string, issueIdentifierOrId: string): ThreadPaths {
  const safeIssue = sanitizeSegment(issueIdentifierOrId);
  const rootDir = join(workspaceDir, "system", "sessions", "webhook", safeIssue);
  return {
    rootDir,
    sessionFile: join(rootDir, "session.jsonl"),
    logFile: join(rootDir, "log.jsonl"),
    attachmentsDir: join(rootDir, "attachments"),
    scratchDir: join(rootDir, "scratch"),
  };
}

function hasSchedulerRuntimeState(job: Partial<SchedulerJob>): boolean {
  return Boolean(
    job.nextRunAt
      || job.lastRunAt
      || job.lastStatus
      || job.lastError
      || job.lastResult,
  );
}

function mergeSchedulerJobConfigsWithStatuses(
  jobs: SchedulerJobConfig[],
  statuses: SchedulerJobStatus[],
): SchedulerJob[] {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return jobs.map((job) => ({
    ...job,
    ...(statusById.get(job.id) ?? {}),
  }));
}

export function projectSchedulerJobConfigs(jobs: SchedulerJob[]): SchedulerJobConfig[] {
  return jobs.map((job) => schedulerJobConfigSchema.parse(job));
}

export function projectSchedulerJobStatuses(jobs: SchedulerJob[]): SchedulerJobStatus[] {
  return jobs
    .map((job) => {
      if (!hasSchedulerRuntimeState(job)) {
        return undefined;
      }
      return schedulerJobStatusSchema.parse({
        id: job.id,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        lastResult: job.lastResult,
      });
    })
    .filter((job): job is SchedulerJobStatus => Boolean(job));
}

function mergeSchedulerJobStatuses(
  current: SchedulerJobStatus[],
  incoming: SchedulerJobStatus[],
): SchedulerJobStatus[] {
  const merged = new Map(current.map((status) => [status.id, status]));
  for (const status of incoming) {
    if (!merged.has(status.id)) {
      merged.set(status.id, status);
    }
  }
  return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function isMaterializedBuiltInReviewJob(job: SchedulerJobConfig): boolean {
  return Boolean(job.action);
}

async function readSchedulerJobConfigsFile(path: string): Promise<SchedulerJobConfig[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  const jobs = schedulerJobConfigsSchema.parse(parsed);
  return jobs.filter((job) => !isMaterializedBuiltInReviewJob(job));
}

async function readSchedulerJobStatusesFile(path: string): Promise<SchedulerJobStatus[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  return schedulerJobStatusesSchema.parse(parsed);
}

async function migrateLegacySchedulerPersistence(paths: SystemPaths): Promise<void> {
  const rawJobs = await readFile(paths.jobsFile, "utf8");
  const parsedJobs = schedulerJobsSchema.parse(JSON.parse(rawJobs));
  const nextConfigs = projectSchedulerJobConfigs(parsedJobs).filter((job) => !isMaterializedBuiltInReviewJob(job));
  const existingStatuses = await readSchedulerJobStatusesFile(paths.jobStatusFile);
  const nextStatuses = mergeSchedulerJobStatuses(existingStatuses, projectSchedulerJobStatuses(parsedJobs));
  const nextJobsText = `${JSON.stringify(nextConfigs, null, 2)}\n`;
  const nextStatusesText = `${JSON.stringify(nextStatuses, null, 2)}\n`;
  const rawStatuses = await readFile(paths.jobStatusFile, "utf8");

  if (rawJobs !== nextJobsText) {
    await writeFile(paths.jobsFile, nextJobsText, "utf8");
  }
  if (rawStatuses !== nextStatusesText) {
    await writeFile(paths.jobStatusFile, nextStatusesText, "utf8");
  }
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
    await stat(paths.jobStatusFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(paths.jobStatusFile, "[]\n", "utf8");
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

  try {
    await stat(paths.workspaceAgentsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(paths.workspaceAgentsFile, "\n", "utf8");
    } else {
      throw error;
    }
  }

  try {
    await stat(paths.memoryFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(paths.memoryFile, "\n", "utf8");
    } else {
      throw error;
    }
  }

  try {
    await stat(paths.agendaTemplateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(paths.agendaTemplateFile, "\n", "utf8");
    } else {
      throw error;
    }
  }

  try {
    await stat(paths.notionPagesFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(paths.notionPagesFile, "[]\n", "utf8");
    } else {
      throw error;
    }
  }

  await migrateLegacySchedulerPersistence(paths);
}

export async function loadSchedulerJobConfigs(paths: SystemPaths): Promise<SchedulerJobConfig[]> {
  try {
    return await readSchedulerJobConfigsFile(paths.jobsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await ensureSystemWorkspace(paths);
      return [];
    }
    throw error;
  }
}

export async function saveSchedulerJobConfigs(paths: SystemPaths, jobs: SchedulerJobConfig[]): Promise<void> {
  await writeFile(paths.jobsFile, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
}

export async function loadSchedulerJobStatuses(paths: SystemPaths): Promise<SchedulerJobStatus[]> {
  try {
    return await readSchedulerJobStatusesFile(paths.jobStatusFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await ensureSystemWorkspace(paths);
      return [];
    }
    throw error;
  }
}

export async function saveSchedulerJobStatuses(paths: SystemPaths, statuses: SchedulerJobStatus[]): Promise<void> {
  await writeFile(paths.jobStatusFile, `${JSON.stringify(statuses, null, 2)}\n`, "utf8");
}

export async function saveSchedulerJobStatusesFromJobs(paths: SystemPaths, jobs: SchedulerJob[]): Promise<void> {
  await saveSchedulerJobStatuses(paths, projectSchedulerJobStatuses(jobs));
}

export async function loadSchedulerJobs(paths: SystemPaths): Promise<SchedulerJob[]> {
  const [jobs, statuses] = await Promise.all([
    loadSchedulerJobConfigs(paths),
    loadSchedulerJobStatuses(paths),
  ]);
  return mergeSchedulerJobConfigsWithStatuses(jobs, statuses);
}

export async function saveSchedulerJobs(paths: SystemPaths, jobs: SchedulerJob[]): Promise<void> {
  await Promise.all([
    saveSchedulerJobConfigs(paths, projectSchedulerJobConfigs(jobs)),
    saveSchedulerJobStatusesFromJobs(paths, jobs),
  ]);
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

export async function readWorkspaceMemory(paths: SystemPaths): Promise<string | undefined> {
  try {
    const raw = stripGeneratedPersonalizationMarkers(await readFile(paths.memoryFile, "utf8"));
    const normalized = raw.trim();
    return normalized ? normalized : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readWorkspaceAgents(paths: SystemPaths): Promise<string | undefined> {
  try {
    const raw = stripGeneratedPersonalizationMarkers(await readFile(paths.workspaceAgentsFile, "utf8"));
    const normalized = raw.trim();
    return normalized ? normalized : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readAgendaTemplate(paths: SystemPaths): Promise<string | undefined> {
  try {
    const raw = await readFile(paths.agendaTemplateFile, "utf8");
    const normalized = raw.trim();
    return normalized ? normalized : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function loadWorkspaceCustomization(paths: SystemPaths): Promise<WorkspaceCustomizationContext> {
  const [workspaceAgents, workspaceMemory, agendaTemplate] = await Promise.all([
    readWorkspaceAgents(paths),
    readWorkspaceMemory(paths),
    readAgendaTemplate(paths),
  ]);
  return {
    workspaceAgents,
    workspaceMemory,
    agendaTemplate,
  };
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
