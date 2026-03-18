// Compatibility layer for legacy callers and tests.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_OWNER_MAP,
  DEFAULT_POLICY,
  type FollowupLedgerEntry,
  type IntakeLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type OwnerMapEntry,
  type PlanningLedgerEntry,
} from "../state/manager-state-contract.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { SchedulerJob, SystemPaths } from "./system-workspace.js";
import { loadSchedulerJobs, saveSchedulerJobs } from "./system-workspace.js";

export type {
  FollowupLedgerEntry,
  IntakeLedgerEntry,
  ManagerPolicy,
  OwnerMap,
  OwnerMapEntry,
  PlanningLedgerEntry,
} from "../state/manager-state-contract.js";

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
  return createFileBackedManagerRepositories(paths).policy.load();
}

export async function loadOwnerMap(paths: SystemPaths): Promise<OwnerMap> {
  return createFileBackedManagerRepositories(paths).ownerMap.load();
}

export async function loadIntakeLedger(paths: SystemPaths): Promise<IntakeLedgerEntry[]> {
  return createFileBackedManagerRepositories(paths).intake.load();
}

export async function saveIntakeLedger(paths: SystemPaths, ledger: IntakeLedgerEntry[]): Promise<void> {
  await createFileBackedManagerRepositories(paths).intake.save(ledger);
}

export async function loadFollowupsLedger(paths: SystemPaths): Promise<FollowupLedgerEntry[]> {
  return createFileBackedManagerRepositories(paths).followups.load();
}

export async function saveFollowupsLedger(paths: SystemPaths, ledger: FollowupLedgerEntry[]): Promise<void> {
  await createFileBackedManagerRepositories(paths).followups.save(ledger);
}

export async function loadPlanningLedger(paths: SystemPaths): Promise<PlanningLedgerEntry[]> {
  return createFileBackedManagerRepositories(paths).planning.load();
}

export async function savePlanningLedger(paths: SystemPaths, ledger: PlanningLedgerEntry[]): Promise<void> {
  await createFileBackedManagerRepositories(paths).planning.save(ledger);
}
