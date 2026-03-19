import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureManagerSystemFiles, loadManagerPolicy, loadOwnerMap } from "../src/lib/manager-state.js";
import { buildHeartbeatPaths, buildSchedulerPaths, buildSystemPaths, ensureSystemWorkspace } from "../src/lib/system-workspace.js";

describe("system workspace helpers", () => {
  it("builds system root paths", () => {
    const paths = buildSystemPaths("/workspace");

    expect(paths.rootDir).toBe("/workspace/system");
    expect(paths.jobsFile).toBe("/workspace/system/jobs.json");
    expect(paths.heartbeatPromptFile).toBe("/workspace/system/HEARTBEAT.md");
    expect(paths.policyFile).toBe("/workspace/system/policy.json");
    expect(paths.ownerMapFile).toBe("/workspace/system/owner-map.json");
    expect(paths.compatIntakeLedgerFile).toBe("/workspace/system/intake-ledger.json");
    expect(paths.workgraphEventsFile).toBe("/workspace/system/workgraph-events.jsonl");
  });

  it("builds heartbeat session paths", () => {
    const paths = buildHeartbeatPaths("/workspace", "C123");

    expect(paths.rootDir).toBe("/workspace/system/sessions/heartbeat/C123");
    expect(paths.sessionFile).toBe("/workspace/system/sessions/heartbeat/C123/session.jsonl");
  });

  it("builds scheduler session paths", () => {
    const paths = buildSchedulerPaths("/workspace", "job:1");

    expect(paths.rootDir).toBe("/workspace/system/sessions/cron/job_1");
    expect(paths.sessionFile).toBe("/workspace/system/sessions/cron/job_1/session.jsonl");
  });

  it("creates default manager files and review jobs", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-system-"));
    const paths = buildSystemPaths(workspaceDir);

    await ensureManagerSystemFiles(paths);

    const policy = await loadManagerPolicy(paths);
    const ownerMap = await loadOwnerMap(paths);
    const jobs = JSON.parse(await readFile(paths.jobsFile, "utf8")) as Array<{ id: string }>;

    expect(policy.controlRoomChannelId).toBe("C0ALAMDRB9V");
    expect(ownerMap.defaultOwner).toBe("kyaukyuai");
    expect(jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([
        "manager-review-morning",
        "manager-review-evening",
        "manager-review-weekly",
      ]),
    );
  });

  it("writes a default heartbeat prompt for fresh workspaces", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-heartbeat-"));
    const paths = buildSystemPaths(workspaceDir);

    await ensureSystemWorkspace(paths);

    const heartbeatPrompt = await readFile(paths.heartbeatPromptFile, "utf8");
    expect(heartbeatPrompt).toContain("Return at most one issue-centric update.");
    expect(heartbeatPrompt).toContain("HEARTBEAT_OK");
  });
});
