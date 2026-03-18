import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedWorkgraphRepository } from "../src/state/workgraph/file-backed-workgraph-repository.js";
import { resolveIssueTargetsFromThread } from "../src/orchestrators/updates/target-resolution.js";

describe("resolveIssueTargetsFromThread", () => {
  it("uses workgraph planning context when intake ledger is empty", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-target-resolution-"));
    const repository = createFileBackedWorkgraphRepository(buildSystemPaths(workspaceDir));

    await repository.append([
      {
        type: "planning.child_created",
        occurredAt: "2026-03-18T00:00:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-1",
        issueId: "AIC-11",
        title: "動作確認",
        kind: "execution",
      },
      {
        type: "issue.progressed",
        occurredAt: "2026-03-18T00:10:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-2",
        issueId: "AIC-11",
      },
    ]);

    const resolution = await resolveIssueTargetsFromThread(
      {
        channelId: "C123",
        rootThreadTs: "thread-1",
        text: "進捗です",
      },
      "progress",
      workspaceDir,
      {} as never,
      repository,
    );

    expect(resolution).toEqual({
      selectedIssueIds: ["AIC-11"],
      candidates: [{ issueId: "AIC-11" }],
      reason: "thread",
    });
  });
});
