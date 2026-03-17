import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { SchedulerJob, SystemPaths } from "./system-workspace.js";
import { loadSchedulerJobs, saveSchedulerJobs } from "./system-workspace.js";

const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const managerPolicySchema = z.object({
  controlRoomChannelId: z.string().min(1),
  businessHours: z.object({
    timezone: z.literal("Asia/Tokyo").default("Asia/Tokyo"),
    weekdays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
    start: timeSchema.default("09:00"),
    end: timeSchema.default("18:00"),
  }),
  reviewCadence: z.object({
    morning: timeSchema.default("09:00"),
    evening: timeSchema.default("17:00"),
    weeklyDay: weekdaySchema.default("mon"),
    weeklyTime: timeSchema.default("09:30"),
  }),
  heartbeatIntervalMin: z.number().int().min(0).default(30),
  staleBusinessDays: z.number().int().positive().default(3),
  blockedBusinessDays: z.number().int().positive().default(1),
  followupCooldownHours: z.number().int().positive().default(24),
  clarificationCooldownHours: z.number().int().positive().default(12),
  fallbackOwner: z.string().min(1).default("kyaukyuai"),
  autoCreate: z.boolean().default(true),
  autoStatusUpdate: z.boolean().default(true),
  autoAssign: z.boolean().default(true),
  autoPlan: z.boolean().default(true),
  reviewExplicitFollowupCount: z.number().int().min(0).max(3).default(1),
  researchAutoPlanMinActions: z.number().int().min(1).max(10).default(2),
  researchAutoPlanMaxChildren: z.number().int().min(1).max(10).default(3),
  urgentPriorityThreshold: z.number().int().min(0).max(4).default(2),
});

const ownerMapEntrySchema = z.object({
  id: z.string().min(1),
  domains: z.array(z.string().min(1)).default([]),
  keywords: z.array(z.string().min(1)).default([]),
  linearAssignee: z.string().min(1),
  slackUserId: z.string().optional(),
  primary: z.boolean().default(false),
});

const ownerMapSchema = z.object({
  defaultOwner: z.string().min(1),
  entries: z.array(ownerMapEntrySchema),
});

const intakeLedgerEntrySchema = z.object({
  sourceChannelId: z.string().min(1),
  sourceThreadTs: z.string().min(1),
  sourceMessageTs: z.string().min(1),
  messageFingerprint: z.string().min(1),
  parentIssueId: z.string().optional(),
  childIssueIds: z.array(z.string()).default([]),
  status: z.string().min(1),
  ownerResolution: z.enum(["mapped", "fallback"]).optional(),
  originalText: z.string().optional(),
  clarificationQuestion: z.string().optional(),
  clarificationReasons: z.array(z.string()).default([]),
  lastResolvedIssueId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const followupLedgerEntrySchema = z.object({
  issueId: z.string().min(1),
  lastPublicFollowupAt: z.string().datetime().optional(),
  lastEscalationAt: z.string().datetime().optional(),
  lastCategory: z.string().optional(),
});

const planningLedgerEntrySchema = z.object({
  sourceThread: z.string().min(1),
  parentIssueId: z.string().optional(),
  generatedChildIssueIds: z.array(z.string()).default([]),
  planningReason: z.string().min(1),
  ownerResolution: z.enum(["mapped", "fallback"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const intakeLedgerSchema = z.array(intakeLedgerEntrySchema);
const followupsLedgerSchema = z.array(followupLedgerEntrySchema);
const planningLedgerSchema = z.array(planningLedgerEntrySchema);

export type ManagerPolicy = z.infer<typeof managerPolicySchema>;
export type OwnerMap = z.infer<typeof ownerMapSchema>;
export type OwnerMapEntry = z.infer<typeof ownerMapEntrySchema>;
export type IntakeLedgerEntry = z.infer<typeof intakeLedgerEntrySchema>;
export type FollowupLedgerEntry = z.infer<typeof followupLedgerEntrySchema>;
export type PlanningLedgerEntry = z.infer<typeof planningLedgerEntrySchema>;

const DEFAULT_POLICY: ManagerPolicy = {
  controlRoomChannelId: "C0ALAMDRB9V",
  businessHours: {
    timezone: "Asia/Tokyo",
    weekdays: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
  },
  reviewCadence: {
    morning: "09:00",
    evening: "17:00",
    weeklyDay: "mon",
    weeklyTime: "09:30",
  },
  heartbeatIntervalMin: 30,
  staleBusinessDays: 3,
  blockedBusinessDays: 1,
  followupCooldownHours: 24,
  clarificationCooldownHours: 12,
  fallbackOwner: "kyaukyuai",
  autoCreate: true,
  autoStatusUpdate: true,
  autoAssign: true,
  autoPlan: true,
  reviewExplicitFollowupCount: 1,
  researchAutoPlanMinActions: 2,
  researchAutoPlanMaxChildren: 3,
  urgentPriorityThreshold: 2,
};

const DEFAULT_OWNER_MAP: OwnerMap = {
  defaultOwner: "kyaukyuai",
  entries: [
    {
      id: "kyaukyuai",
      domains: ["default", "research", "slack", "linear"],
      keywords: ["slack", "linear", "bot", "manager", "調査", "確認"],
      linearAssignee: "y.kakui",
      primary: true,
    },
  ],
};

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureJsonFile<T>(path: string, defaultValue: T): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await writeJsonFile(path, defaultValue);
      return;
    }
    throw error;
  }
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function buildManagerReviewJobs(policy: ManagerPolicy): SchedulerJob[] {
  return [
    {
      id: "manager-review-morning",
      enabled: true,
      channelId: policy.controlRoomChannelId,
      prompt: "manager review: morning",
      kind: "daily",
      time: policy.reviewCadence.morning,
      action: "morning-review",
    },
    {
      id: "manager-review-evening",
      enabled: true,
      channelId: policy.controlRoomChannelId,
      prompt: "manager review: evening",
      kind: "daily",
      time: policy.reviewCadence.evening,
      action: "evening-review",
    },
    {
      id: "manager-review-weekly",
      enabled: true,
      channelId: policy.controlRoomChannelId,
      prompt: "manager review: weekly",
      kind: "weekly",
      weekday: policy.reviewCadence.weeklyDay,
      time: policy.reviewCadence.weeklyTime,
      action: "weekly-review",
    },
  ];
}

function mergeSchedulerJob(existing: SchedulerJob | undefined, desired: SchedulerJob): SchedulerJob {
  if (!existing) {
    return desired;
  }

  return {
    ...existing,
    channelId: desired.channelId,
    prompt: desired.prompt,
    kind: desired.kind,
    time: desired.time,
    weekday: desired.weekday,
    action: desired.action,
    at: desired.at,
    everySec: desired.everySec,
  };
}

export async function ensureManagerSystemFiles(paths: SystemPaths): Promise<void> {
  await ensureJsonFile(paths.policyFile, DEFAULT_POLICY);
  await ensureJsonFile(paths.ownerMapFile, DEFAULT_OWNER_MAP);
  await ensureJsonFile(paths.intakeLedgerFile, []);
  await ensureJsonFile(paths.followupsFile, []);
  await ensureJsonFile(paths.planningLedgerFile, []);

  const policy = await loadManagerPolicy(paths);
  const jobs = await loadSchedulerJobs(paths);
  const desiredJobs = buildManagerReviewJobs(policy);
  const nextJobs = [...jobs];

  for (const desiredJob of desiredJobs) {
    const index = nextJobs.findIndex((job) => job.id === desiredJob.id);
    if (index === -1) {
      nextJobs.push(desiredJob);
      continue;
    }
    nextJobs[index] = mergeSchedulerJob(nextJobs[index], desiredJob);
  }

  if (JSON.stringify(jobs) !== JSON.stringify(nextJobs)) {
    await saveSchedulerJobs(paths, nextJobs);
  }
}

export async function loadManagerPolicy(paths: SystemPaths): Promise<ManagerPolicy> {
  return managerPolicySchema.parse((await readJsonFile(paths.policyFile)) ?? DEFAULT_POLICY);
}

export async function loadOwnerMap(paths: SystemPaths): Promise<OwnerMap> {
  return ownerMapSchema.parse((await readJsonFile(paths.ownerMapFile)) ?? DEFAULT_OWNER_MAP);
}

export async function loadIntakeLedger(paths: SystemPaths): Promise<IntakeLedgerEntry[]> {
  return intakeLedgerSchema.parse((await readJsonFile(paths.intakeLedgerFile)) ?? []);
}

export async function saveIntakeLedger(paths: SystemPaths, ledger: IntakeLedgerEntry[]): Promise<void> {
  await writeJsonFile(paths.intakeLedgerFile, ledger);
}

export async function loadFollowupsLedger(paths: SystemPaths): Promise<FollowupLedgerEntry[]> {
  return followupsLedgerSchema.parse((await readJsonFile(paths.followupsFile)) ?? []);
}

export async function saveFollowupsLedger(paths: SystemPaths, ledger: FollowupLedgerEntry[]): Promise<void> {
  await writeJsonFile(paths.followupsFile, ledger);
}

export async function loadPlanningLedger(paths: SystemPaths): Promise<PlanningLedgerEntry[]> {
  return planningLedgerSchema.parse((await readJsonFile(paths.planningLedgerFile)) ?? []);
}

export async function savePlanningLedger(paths: SystemPaths, ledger: PlanningLedgerEntry[]): Promise<void> {
  await writeJsonFile(paths.planningLedgerFile, ledger);
}
