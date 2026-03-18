import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureManagerSystemFiles,
  loadFollowupsLedger,
  loadIntakeLedger,
  loadPlanningLedger,
} from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

describe("file-backed manager repositories", () => {
  it("persists manager state without changing compatibility reads", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-repositories-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    const now = new Date("2026-03-18T00:00:00.000Z").toISOString();

    await ensureManagerSystemFiles(systemPaths);

    const repositories = createFileBackedManagerRepositories(systemPaths);
    const policy = await repositories.policy.load();
    const ownerMap = await repositories.ownerMap.load();

    expect(policy.controlRoomChannelId).toBe("C0ALAMDRB9V");
    expect(ownerMap.defaultOwner).toBe("kyaukyuai");

    const intakeLedger = [
      {
        sourceChannelId: "C123",
        sourceThreadTs: "1710000000.000100",
        sourceMessageTs: "1710000000.000100",
        messageFingerprint: "contract-signing",
        childIssueIds: ["AIC-2"],
        status: "planned",
        clarificationReasons: [],
        issueFocusHistory: [],
        createdAt: now,
        updatedAt: now,
      },
    ];
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

    await repositories.intake.save(intakeLedger);
    await repositories.followups.save(followups);
    await repositories.planning.save(planningLedger);

    expect(await loadIntakeLedger(systemPaths)).toEqual(intakeLedger);
    expect(await loadFollowupsLedger(systemPaths)).toEqual(followups);
    expect(await loadPlanningLedger(systemPaths)).toEqual(planningLedger);
  });
});
