// Compatibility layer for legacy callers and tests.
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_OWNER_MAP,
  DEFAULT_POLICY,
  type FollowupLedgerEntry,
  type ManagerPolicy,
  type NotionManagedPageEntry,
  type OwnerMap,
  type OwnerMapEntry,
  type PersonalizationLedgerEntry,
  type PlanningLedgerEntry,
  type WebhookDeliveryEntry,
} from "../state/manager-state-contract.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { EMPTY_WORKGRAPH_SNAPSHOT } from "../state/workgraph/snapshot.js";
import type { SystemPaths } from "./system-workspace.js";
import { ensureSystemWorkspace } from "./system-workspace.js";

export type {
  FollowupLedgerEntry,
  ManagerPolicy,
  NotionManagedPageEntry,
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
  await ensureSystemWorkspace(paths);
  await ensureJsonFile(paths.policyFile, DEFAULT_POLICY);
  await ensureJsonFile(paths.ownerMapFile, DEFAULT_OWNER_MAP);
  await ensureJsonFile(paths.followupsFile, []);
  await ensureJsonFile(paths.planningLedgerFile, []);
  await ensureJsonFile(paths.personalizationLedgerFile, []);
  await ensureJsonFile(paths.notionPagesFile, []);
  await ensureJsonFile(paths.webhookDeliveriesFile, []);
  await ensureTextFile(paths.workgraphEventsFile, "");
  await ensureJsonFile(paths.workgraphSnapshotFile, EMPTY_WORKGRAPH_SNAPSHOT);
  await rm(join(paths.rootDir, "intake-ledger.json"), { force: true });
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

export async function saveOwnerMap(paths: SystemPaths, ownerMap: OwnerMap): Promise<void> {
  await createFileBackedManagerRepositories(paths).ownerMap.save(ownerMap);
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

export async function loadPersonalizationLedger(paths: SystemPaths): Promise<PersonalizationLedgerEntry[]> {
  return createFileBackedManagerRepositories(paths).personalization.load();
}

export async function savePersonalizationLedger(paths: SystemPaths, ledger: PersonalizationLedgerEntry[]): Promise<void> {
  await createFileBackedManagerRepositories(paths).personalization.save(ledger);
}

export async function loadManagedNotionPages(paths: SystemPaths): Promise<NotionManagedPageEntry[]> {
  return createFileBackedManagerRepositories(paths).notionPages.load();
}

export async function saveManagedNotionPages(paths: SystemPaths, pages: NotionManagedPageEntry[]): Promise<void> {
  await createFileBackedManagerRepositories(paths).notionPages.save(pages);
}
