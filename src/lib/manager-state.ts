// Compatibility layer for legacy callers and tests.
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_OWNER_MAP,
  DEFAULT_POLICY,
  type FollowupLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type OwnerMapEntry,
  type PlanningLedgerEntry,
  type WebhookDeliveryEntry,
} from "../state/manager-state-contract.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { EMPTY_WORKGRAPH_SNAPSHOT } from "../state/workgraph/snapshot.js";
import type { SystemPaths } from "./system-workspace.js";
import { loadSchedulerJobs, saveSchedulerJobs } from "./system-workspace.js";
import { syncBuiltInReviewJobs } from "./scheduler-management.js";

export type {
  FollowupLedgerEntry,
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

async function ensureTextFile(path: string, defaultValue: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, defaultValue, "utf8");
      return;
    }
    throw error;
  }
}

export async function ensureManagerStateFiles(paths: SystemPaths): Promise<void> {
  await ensureJsonFile(paths.policyFile, DEFAULT_POLICY);
  await ensureJsonFile(paths.ownerMapFile, DEFAULT_OWNER_MAP);
  await ensureJsonFile(paths.followupsFile, []);
  await ensureJsonFile(paths.planningLedgerFile, []);
  await ensureJsonFile(paths.webhookDeliveriesFile, []);
  await ensureTextFile(paths.workgraphEventsFile, "");
  await ensureJsonFile(paths.workgraphSnapshotFile, EMPTY_WORKGRAPH_SNAPSHOT);
  await rm(join(paths.rootDir, "intake-ledger.json"), { force: true });

  const policy = await loadManagerPolicy(paths);
  const jobs = await loadSchedulerJobs(paths);
  const nextJobs = syncBuiltInReviewJobs(policy, jobs);

  if (JSON.stringify(jobs) !== JSON.stringify(nextJobs)) {
    await saveSchedulerJobs(paths, nextJobs);
  }
}

export async function loadManagerPolicy(paths: SystemPaths): Promise<ManagerPolicy> {
  return createFileBackedManagerRepositories(paths).policy.load();
}

export async function saveManagerPolicy(paths: SystemPaths, policy: ManagerPolicy): Promise<void> {
  await writeJsonFile(paths.policyFile, policy);
}

export async function loadOwnerMap(paths: SystemPaths): Promise<OwnerMap> {
  return createFileBackedManagerRepositories(paths).ownerMap.load();
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

export async function loadWebhookDeliveries(paths: SystemPaths): Promise<WebhookDeliveryEntry[]> {
  return createFileBackedManagerRepositories(paths).webhookDeliveries.load();
}

export async function saveWebhookDeliveries(paths: SystemPaths, ledger: WebhookDeliveryEntry[]): Promise<void> {
  await createFileBackedManagerRepositories(paths).webhookDeliveries.save(ledger);
}
