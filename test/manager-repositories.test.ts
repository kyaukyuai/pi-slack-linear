import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ensureManagerStateFiles,
  loadFollowupsLedger,
  loadPlanningLedger,
} from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

describe("file-backed manager repositories", () => {
  it("loads default values from missing files", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-defaults-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);

    await expect(repositories.policy.load()).resolves.toMatchObject({
      controlRoomChannelId: "C0ALAMDRB9V",
      fallbackOwner: "kyaukyuai",
    });
    await expect(repositories.ownerMap.load()).resolves.toMatchObject({
      defaultOwner: "kyaukyuai",
    });
    await expect(repositories.followups.load()).resolves.toEqual([]);
    await expect(repositories.planning.load()).resolves.toEqual([]);
    await expect(repositories.personalization.load()).resolves.toEqual([]);
    await expect(repositories.webhookDeliveries.load()).resolves.toEqual([]);
    await expect(repositories.workgraph.list()).resolves.toEqual([]);
  });

  it("persists manager state without changing file-backed reads", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const now = new Date("2026-03-18T00:00:00.000Z").toISOString();

    await ensureManagerStateFiles(systemPaths);

    const repositories = createFileBackedManagerRepositories(systemPaths);
    const policy = await repositories.policy.load();
    const ownerMap = await repositories.ownerMap.load();

    expect(policy.controlRoomChannelId).toBe("C0ALAMDRB9V");
    expect(ownerMap.defaultOwner).toBe("kyaukyuai");
    const followups = [
      {
        issueId: "AIC-2",
        status: "awaiting-response" as const,
        requestKind: "status" as const,
      },
    ];
    const planningLedger = [
      {
        sourceThread: "C123:1710000000.000100",
        generatedChildIssueIds: ["AIC-2"],
        planningReason: "llm-plan",
        createdAt: now,
        updatedAt: now,
      },
    ];

    await repositories.followups.save(followups);
    await repositories.planning.save(planningLedger);
    await repositories.ownerMap.save({
      defaultOwner: "y.kakui",
      entries: [
        {
          id: "opt",
          domains: ["sales"],
          keywords: ["OPT"],
          linearAssignee: "t.tahira",
          primary: false,
        },
      ],
    });

    expect(await loadFollowupsLedger(systemPaths)).toEqual(followups);
    expect(await loadPlanningLedger(systemPaths)).toEqual(planningLedger);
    await expect(repositories.ownerMap.load()).resolves.toEqual({
      defaultOwner: "y.kakui",
      entries: [
        {
          id: "opt",
          domains: ["sales"],
          keywords: ["OPT"],
          linearAssignee: "t.tahira",
          primary: false,
        },
      ],
    });
  });

  it("reloads saved values from a new repository instance", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-reload-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const now = new Date("2026-03-18T09:00:00.000Z").toISOString();

    const first = createFileBackedManagerRepositories(systemPaths);
    await first.followups.save([
      {
        issueId: "AIC-9",
        status: "resolved",
        resolvedAt: now,
        resolvedReason: "answered",
      },
    ]);

    const second = createFileBackedManagerRepositories(systemPaths);
    await expect(second.followups.load()).resolves.toEqual([
      {
        issueId: "AIC-9",
        status: "resolved",
        resolvedAt: now,
        resolvedReason: "answered",
      },
    ]);
  });

  it("validates stored JSON against the repository schema", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-repositories-invalid-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const repositories = createFileBackedManagerRepositories(systemPaths);

    await mkdir(dirname(systemPaths.policyFile), { recursive: true });
    await writeFile(systemPaths.policyFile, "{\"controlRoomChannelId\":1}\n", "utf8");

    await expect(repositories.policy.load()).rejects.toThrow();
  });
});
