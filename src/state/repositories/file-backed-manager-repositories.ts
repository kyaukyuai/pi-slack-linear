import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { SystemPaths } from "../../lib/system-workspace.js";
import {
  DEFAULT_OWNER_MAP,
  DEFAULT_POLICY,
  followupsLedgerSchema,
  managerPolicySchema,
  ownerMapSchema,
  planningLedgerSchema,
  webhookDeliveriesSchema,
  type FollowupLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type PlanningLedgerEntry,
  type WebhookDeliveryEntry,
} from "../manager-state-contract.js";
import { createFileBackedWorkgraphRepository, type WorkgraphRepository } from "../workgraph/file-backed-workgraph-repository.js";

export interface ReadonlyRepository<T> {
  load(): Promise<T>;
}

export interface MutableRepository<T> extends ReadonlyRepository<T> {
  save(value: T): Promise<void>;
}

export type PolicyRepository = ReadonlyRepository<ManagerPolicy>;
export type OwnerMapRepository = ReadonlyRepository<OwnerMap>;
export type FollowupRepository = MutableRepository<FollowupLedgerEntry[]>;
export type PlanningRepository = MutableRepository<PlanningLedgerEntry[]>;
export type WebhookDeliveryRepository = MutableRepository<WebhookDeliveryEntry[]>;

export interface ManagerRepositories {
  policy: PolicyRepository;
  ownerMap: OwnerMapRepository;
  followups: FollowupRepository;
  planning: PlanningRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  workgraph: WorkgraphRepository;
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

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createReadonlyJsonRepository<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  defaultValue: z.output<S>,
): ReadonlyRepository<z.output<S>> {
  return {
    async load(): Promise<z.output<S>> {
      return schema.parse((await readJsonFile(path)) ?? defaultValue);
    },
  };
}

function createMutableJsonRepository<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  defaultValue: z.output<S>,
): MutableRepository<z.output<S>> {
  const readonlyRepository = createReadonlyJsonRepository(path, schema, defaultValue);
  return {
    load: readonlyRepository.load,
    async save(value: z.output<S>): Promise<void> {
      await writeJsonFile(path, value);
    },
  };
}

export function createFileBackedManagerRepositories(paths: SystemPaths): ManagerRepositories {
  return {
    policy: createReadonlyJsonRepository(paths.policyFile, managerPolicySchema, DEFAULT_POLICY),
    ownerMap: createReadonlyJsonRepository(paths.ownerMapFile, ownerMapSchema, DEFAULT_OWNER_MAP),
    followups: createMutableJsonRepository(paths.followupsFile, followupsLedgerSchema, []),
    planning: createMutableJsonRepository(paths.planningLedgerFile, planningLedgerSchema, []),
    webhookDeliveries: createMutableJsonRepository(paths.webhookDeliveriesFile, webhookDeliveriesSchema, []),
    workgraph: createFileBackedWorkgraphRepository(paths),
  };
}
