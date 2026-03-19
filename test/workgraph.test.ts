import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedWorkgraphRepository } from "../src/state/workgraph/file-backed-workgraph-repository.js";
import { runWorkgraphMaintenance } from "../src/state/workgraph/maintenance.js";
import {
  findExistingThreadIntakeByFingerprint,
  buildIssueSourceIndex,
  getPendingClarificationForThread,
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
        messageFingerprint: "clarify-1",
        clarificationQuestion: "期限を教えてください。",
        clarificationReasons: ["due_date"],
      }),
    ]);

    expect(await getPendingClarificationForThread(repository, "C123:thread-pending")).toEqual(
      expect.objectContaining({
        threadKey: "C123:thread-pending",
        pendingClarification: true,
        sourceMessageTs: "msg-1",
        messageFingerprint: "clarify-1",
        clarificationQuestion: "期限を教えてください。",
        clarificationReasons: ["due_date"],
      }),
    );

    expect(await getThreadContext(repository, "C123:thread-active")).toEqual(expect.objectContaining({
      threadKey: "C123:thread-active",
      parentIssueId: "AIC-10",
      childIssueIds: ["AIC-11"],
      latestFocusIssueId: "AIC-11",
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

    expect(await findExistingThreadIntakeByFingerprint(
      repository,
      "C123:thread-active",
      "create-1",
    )).toEqual({
      threadKey: "C123:thread-active",
      intakeStatus: "created",
      messageFingerprint: "create-1",
      sourceMessageTs: "msg-2",
      originalText: undefined,
      parentIssueId: "AIC-10",
      childIssueIds: ["AIC-11"],
      linkedIssueIds: [],
      lastResolvedIssueId: undefined,
      occurredAt: "2026-03-18T00:10:00.000Z",
    });
  });

  it("projects from a compacted snapshot plus replayed tail events", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-workgraph-snapshot-"));
    const paths = buildSystemPaths(workspaceDir);
    const repository = createFileBackedWorkgraphRepository(paths);

    await repository.append([
      {
        type: "planning.parent_created",
        occurredAt: "2026-03-18T00:00:00.000Z",
        threadKey: "C123:thread-snapshot",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-snapshot",
        sourceMessageTs: "msg-1",
        issueId: "AIC-20",
        title: "障害対応",
      },
      {
        type: "planning.child_created",
        occurredAt: "2026-03-18T00:01:00.000Z",
        threadKey: "C123:thread-snapshot",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-snapshot",
        sourceMessageTs: "msg-1",
        issueId: "AIC-21",
        title: "ログ確認",
        kind: "execution",
        parentIssueId: "AIC-20",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-18T00:01:00.000Z",
        threadKey: "C123:thread-snapshot",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-snapshot",
        sourceMessageTs: "msg-1",
        messageFingerprint: "snapshot-seed",
        parentIssueId: "AIC-20",
        childIssueIds: ["AIC-21"],
        planningReason: "complex-request",
      },
    ]);

    const snapshot = await repository.compact();
    expect(snapshot.eventCount).toBe(3);
    expect(snapshot.compactedEventCount).toBe(3);
    expect(snapshot.projection.threads["C123:thread-snapshot"]).toMatchObject({
      parentIssueId: "AIC-20",
      childIssueIds: ["AIC-21"],
      latestFocusIssueId: "AIC-21",
    });
    await expect(repository.list()).resolves.toEqual([]);

    await repository.append({
      type: "issue.blocked",
      occurredAt: "2026-03-18T00:10:00.000Z",
      threadKey: "C123:thread-snapshot",
      sourceChannelId: "C123",
      sourceThreadTs: "thread-snapshot",
      sourceMessageTs: "msg-2",
      issueId: "AIC-21",
      blockedStateApplied: true,
    });

    expect(await repository.loadSnapshot()).toMatchObject({
      version: 1,
      eventCount: 3,
      compactedEventCount: 3,
      lastOccurredAt: "2026-03-18T00:01:00.000Z",
    });

    expect(await repository.project()).toMatchObject({
      threads: {
        "C123:thread-snapshot": expect.objectContaining({
          latestFocusIssueId: "AIC-21",
          issueStatuses: {
            "AIC-21": "blocked",
          },
        }),
      },
      issues: {
        "AIC-21": expect.objectContaining({
          lastStatus: "blocked",
        }),
      },
    });
  });

  it("recovers a fresh snapshot by replaying the current event log", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-workgraph-recover-"));
    const paths = buildSystemPaths(workspaceDir);
    const repository = createFileBackedWorkgraphRepository(paths);

    await repository.append([
      {
        type: "planning.parent_created",
        occurredAt: "2026-03-18T03:00:00.000Z",
        threadKey: "C123:thread-recover",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-recover",
        sourceMessageTs: "msg-1",
        issueId: "AIC-30",
        title: "障害切り分け",
      },
      {
        type: "issue.progressed",
        occurredAt: "2026-03-18T03:10:00.000Z",
        threadKey: "C123:thread-recover",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-recover",
        sourceMessageTs: "msg-2",
        issueId: "AIC-30",
      },
    ]);

    await writeFile(paths.workgraphSnapshotFile, `${JSON.stringify({
      version: 1,
      eventCount: 999,
      compactedEventCount: 999,
      projection: { issues: {}, threads: {} },
    }, null, 2)}\n`, "utf8");

    const recovered = await repository.recoverSnapshotFromLog();
    expect(recovered).toMatchObject({
      eventCount: 2,
      compactedEventCount: 0,
      projection: {
        issues: {
          "AIC-30": expect.objectContaining({
            lastStatus: "progress",
          }),
        },
      },
    });

    expect(await repository.project()).toMatchObject({
      issues: {
        "AIC-30": expect.objectContaining({
          lastStatus: "progress",
        }),
      },
      threads: {
        "C123:thread-recover": expect.objectContaining({
          latestFocusIssueId: "AIC-30",
          issueStatuses: {
            "AIC-30": "progress",
          },
        }),
      },
    });
  });

  it("reports health and compacts automatically when the active log reaches the threshold", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-workgraph-health-"));
    const paths = buildSystemPaths(workspaceDir);
    const repository = createFileBackedWorkgraphRepository(paths);

    await repository.append([
      {
        type: "planning.parent_created",
        occurredAt: "2026-03-18T04:00:00.000Z",
        threadKey: "C123:thread-health",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-health",
        sourceMessageTs: "msg-1",
        issueId: "AIC-40",
        title: "ヘルス確認",
      },
      {
        type: "issue.progressed",
        occurredAt: "2026-03-18T04:10:00.000Z",
        threadKey: "C123:thread-health",
        sourceChannelId: "C123",
        sourceThreadTs: "thread-health",
        sourceMessageTs: "msg-2",
        issueId: "AIC-40",
      },
    ]);

    expect(await repository.health({
      warnActiveLogEvents: 1,
      autoCompactMaxActiveLogEvents: 2,
    })).toMatchObject({
      status: "warning",
      activeLogEventCount: 2,
      replayTailEventCount: 2,
      compactRecommended: true,
      issueCount: 1,
      threadCount: 1,
    });

    const maintenance = await runWorkgraphMaintenance(repository, {
      warnActiveLogEvents: 1,
      autoCompactMaxActiveLogEvents: 2,
    });
    expect(maintenance.action).toBe("compacted");
    expect(maintenance.after).toMatchObject({
      status: "ok",
      activeLogEventCount: 0,
      compactedEventCount: 2,
      snapshotEventCount: 2,
    });
    await expect(repository.list()).resolves.toEqual([]);
  });

  it("flags recovery-required when the snapshot claims more tail events than the active log contains", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-workgraph-health-recovery-"));
    const paths = buildSystemPaths(workspaceDir);
    const repository = createFileBackedWorkgraphRepository(paths);

    await repository.append({
      type: "planning.parent_created",
      occurredAt: "2026-03-18T05:00:00.000Z",
      threadKey: "C123:thread-health-recovery",
      sourceChannelId: "C123",
      sourceThreadTs: "thread-health-recovery",
      sourceMessageTs: "msg-1",
      issueId: "AIC-41",
      title: "リカバリ確認",
    });
    await writeFile(paths.workgraphSnapshotFile, `${JSON.stringify({
      version: 1,
      eventCount: 4,
      compactedEventCount: 1,
      lastOccurredAt: "2026-03-18T05:00:00.000Z",
      projection: {
        issues: {},
        threads: {},
      },
    }, null, 2)}\n`, "utf8");

    expect(await repository.health({
      warnActiveLogEvents: 10,
      autoCompactMaxActiveLogEvents: 20,
    })).toMatchObject({
      status: "recovery-required",
      snapshotAheadOfLog: true,
      activeLogEventCount: 1,
    });
  });
});
