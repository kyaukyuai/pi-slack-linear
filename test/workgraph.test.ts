import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedWorkgraphRepository } from "../src/state/workgraph/file-backed-workgraph-repository.js";

describe("workgraph repository", () => {
  it("appends events and projects unified thread and issue state", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-workgraph-"));
    const paths = buildSystemPaths(workspaceDir);
    const repository = createFileBackedWorkgraphRepository(paths);

    await repository.append([
      {
        type: "planning.parent_created",
        occurredAt: "2026-03-18T00:00:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-1",
        issueId: "AIC-1",
        title: "契約締結",
      },
      {
        type: "planning.child_created",
        occurredAt: "2026-03-18T00:00:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-1",
        issueId: "AIC-2",
        title: "ドラフト作成",
        kind: "execution",
        parentIssueId: "AIC-1",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-18T00:00:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-1",
        messageFingerprint: "contract",
        parentIssueId: "AIC-1",
        childIssueIds: ["AIC-2"],
        planningReason: "complex-request",
        ownerResolution: "mapped",
        lastResolvedIssueId: "AIC-2",
      },
      {
        type: "followup.requested",
        occurredAt: "2026-03-18T01:00:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-2",
        issueId: "AIC-2",
        category: "stale",
        requestKind: "status",
      },
      {
        type: "issue.completed",
        occurredAt: "2026-03-18T02:00:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-3",
        issueId: "AIC-2",
      },
      {
        type: "followup.resolved",
        occurredAt: "2026-03-18T02:00:00.000Z",
        threadKey: "C123:thread-1",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        sourceMessageTs: "msg-3",
        issueId: "AIC-2",
        reason: "completed",
        responseKind: "completed",
      },
    ]);

    const events = await repository.list();
    expect(events).toHaveLength(6);

    const projection = await repository.project();
    expect(projection.threads["C123:thread-1"]).toMatchObject({
      intakeStatus: "created",
      parentIssueId: "AIC-1",
      lastResolvedIssueId: "AIC-2",
      pendingClarification: false,
      awaitingFollowupIssueIds: [],
      issueStatuses: {
        "AIC-2": "completed",
      },
    });
    expect(projection.issues["AIC-2"]).toMatchObject({
      parentIssueId: "AIC-1",
      kind: "execution",
      lastStatus: "completed",
      followupStatus: "resolved",
      lastFollowupResolvedReason: "completed",
    });
  });
});
