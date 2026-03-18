import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedWorkgraphRepository } from "../src/state/workgraph/file-backed-workgraph-repository.js";
import {
  buildIssueSourceIndex,
  getLatestIssueSource,
  getLatestResolvedIssueForThread,
  getIssueContext,
  getThreadPlanningContext,
  getThreadContext,
  listAwaitingFollowups,
  listPendingClarifications,
  listThreadIssueCandidates,
} from "../src/state/workgraph/queries.js";

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

  it("exposes thread and issue read models through query helpers", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-workgraph-query-"));
    const paths = buildSystemPaths(workspaceDir);
    const repository = createFileBackedWorkgraphRepository(paths);

    await repository.append([
      {
        type: "intake.clarification_requested",
        occurredAt: "2026-03-18T00:00:00.000Z",
        threadKey: "C123:thread-pending",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-pending",
        sourceMessageTs: "msg-1",
        messageFingerprint: "clarify-1",
        clarificationQuestion: "期限を教えてください。",
        clarificationReasons: ["due_date"],
      },
      {
        type: "planning.parent_created",
        occurredAt: "2026-03-18T00:10:00.000Z",
        threadKey: "C123:thread-active",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-active",
        sourceMessageTs: "msg-2",
        issueId: "AIC-10",
        title: "リリース対応",
      },
      {
        type: "planning.child_created",
        occurredAt: "2026-03-18T00:10:00.000Z",
        threadKey: "C123:thread-active",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-active",
        sourceMessageTs: "msg-2",
        issueId: "AIC-11",
        title: "動作確認",
        kind: "execution",
        parentIssueId: "AIC-10",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-18T00:10:00.000Z",
        threadKey: "C123:thread-active",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-active",
        sourceMessageTs: "msg-2",
        messageFingerprint: "create-1",
        parentIssueId: "AIC-10",
        childIssueIds: ["AIC-11"],
        planningReason: "complex-request",
      },
      {
        type: "followup.requested",
        occurredAt: "2026-03-18T01:00:00.000Z",
        threadKey: "C123:thread-active",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-active",
        sourceMessageTs: "msg-3",
        issueId: "AIC-11",
        category: "stale",
        requestKind: "status",
      },
    ]);

    expect(await listPendingClarifications(repository)).toEqual([
      expect.objectContaining({
        threadKey: "C123:thread-pending",
        pendingClarification: true,
        intakeStatus: "needs-clarification",
      }),
    ]);

    expect(await getThreadContext(repository, "C123:thread-active")).toEqual(expect.objectContaining({
      threadKey: "C123:thread-active",
      parentIssueId: "AIC-10",
      childIssueIds: ["AIC-11"],
      sourceMessageTs: "msg-2",
      awaitingFollowupIssueIds: ["AIC-11"],
    }));

    expect(await getIssueContext(repository, "AIC-11")).toEqual(expect.objectContaining({
      issueId: "AIC-11",
      parentIssueId: "AIC-10",
      followupStatus: "awaiting-response",
    }));

    expect(await getLatestResolvedIssueForThread(repository, "C123:thread-active")).toEqual(expect.objectContaining({
      issueId: "AIC-11",
      parentIssueId: "AIC-10",
    }));

    expect(await listThreadIssueCandidates(repository, "C123:thread-active")).toEqual([
      expect.objectContaining({ issueId: "AIC-11" }),
      expect.objectContaining({ issueId: "AIC-10" }),
    ]);

    expect(await getThreadPlanningContext(repository, "C123:thread-active")).toEqual(expect.objectContaining({
      thread: expect.objectContaining({
        threadKey: "C123:thread-active",
        parentIssueId: "AIC-10",
        childIssueIds: ["AIC-11"],
      }),
      parentIssue: expect.objectContaining({ issueId: "AIC-10" }),
      childIssues: [expect.objectContaining({ issueId: "AIC-11" })],
      latestResolvedIssue: expect.objectContaining({ issueId: "AIC-11" }),
    }));

    expect(await listAwaitingFollowups(repository)).toEqual([
      expect.objectContaining({
        issueId: "AIC-11",
        followupStatus: "awaiting-response",
      }),
    ]);

    expect(await getLatestIssueSource(repository, "AIC-11")).toEqual({
      channelId: "C123",
      rootThreadTs: "thread-active",
      sourceMessageTs: "msg-2",
      lastEventAt: "2026-03-18T01:00:00.000Z",
    });

    expect(await buildIssueSourceIndex(repository)).toEqual({
      "AIC-10": {
        channelId: "C123",
        rootThreadTs: "thread-active",
        sourceMessageTs: "msg-2",
        lastEventAt: "2026-03-18T01:00:00.000Z",
      },
      "AIC-11": {
        channelId: "C123",
        rootThreadTs: "thread-active",
        sourceMessageTs: "msg-2",
        lastEventAt: "2026-03-18T01:00:00.000Z",
      },
    });
  });
});
