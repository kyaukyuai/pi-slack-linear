import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildManagerIssueDiagnostics, buildManagerThreadDiagnostics } from "../src/lib/manager-diagnostics.js";
import { saveLastManagerAgentTurn } from "../src/lib/last-manager-agent-turn.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { savePendingManagerClarification } from "../src/lib/pending-manager-clarification.js";
import { saveThreadQueryContinuation } from "../src/lib/query-continuation.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { appendThreadLog, buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
import { recordPlanningOutcome } from "../src/state/workgraph/recorder.js";

const linearMocks = vi.hoisted(() => ({
  getLinearIssue: vi.fn(),
}));

vi.mock("../src/lib/linear.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/linear.js")>("../src/lib/linear.js");
  return {
    ...actual,
    getLinearIssue: linearMocks.getLinearIssue,
  };
});

describe("manager diagnostics", () => {
  let workspaceDir: string;
  let repositories: ReturnType<typeof createFileBackedManagerRepositories>;
  const config = {
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
    anthropicApiKey: undefined,
    linearApiKey: "lin_api_test",
    linearWorkspace: "kyaukyuai",
    linearTeamKey: "AIC",
    notionApiToken: undefined,
    notionAgendaParentPageId: undefined,
    botModel: "claude-sonnet-4-5",
    workspaceDir: "",
    linearWebhookEnabled: false,
    linearWebhookPublicUrl: undefined,
    linearWebhookSecret: undefined,
    linearWebhookPort: 8787,
    linearWebhookPath: "/hooks/linear",
    heartbeatIntervalMin: 30,
    heartbeatActiveLookbackHours: 24,
    schedulerPollSec: 30,
    workgraphMaintenanceIntervalMin: 15,
    workgraphHealthWarnActiveEvents: 200,
    workgraphAutoCompactMaxActiveEvents: 500,
    logLevel: "info" as const,
  };

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "manager-diagnostics-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);
    repositories = createFileBackedManagerRepositories(systemPaths);
    linearMocks.getLinearIssue.mockReset().mockResolvedValue({
      id: "issue-970",
      identifier: "AIC-970",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-970",
      relations: [],
      inverseRelations: [],
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("builds thread diagnostics with workgraph and Slack context", async () => {
    const clarificationRecordedAt = new Date().toISOString();
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-19T04:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-diagnostics",
        messageTs: "msg-seed-1",
      },
      messageFingerprint: "diag-thread-seed",
      childIssues: [
        { issueId: "AIC-970", title: "OPT社の社内チャネルへの招待依頼", kind: "execution" },
      ],
      planningReason: "single-issue",
      lastResolvedIssueId: "AIC-970",
      originalText: "招待依頼を追加する",
    });

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-diagnostics");
    await ensureThreadWorkspace(threadPaths);
    await appendThreadLog(threadPaths, {
      type: "user",
      ts: "msg-seed-1",
      threadTs: "thread-diagnostics",
      userId: "U1",
      text: "招待依頼を追加する",
    });
    await appendThreadLog(threadPaths, {
      type: "assistant",
      ts: "msg-seed-2",
      threadTs: "thread-diagnostics",
      text: "AIC-970 として登録しました。",
    });
    await saveThreadQueryContinuation(threadPaths, {
      kind: "what-should-i-do",
      scope: "team",
      userMessage: "今日やるべきタスクある？",
      replySummary: "今日まず見るなら AIC-970 です。",
      issueIds: ["AIC-970"],
      shownIssueIds: ["AIC-970"],
      remainingIssueIds: [],
      totalItemCount: 1,
      recordedAt: "2026-03-19T04:05:00.000Z",
    });
    await savePendingManagerClarification(threadPaths, {
      intent: "create_work",
      originalUserMessage: "Slack 表示崩れを直す task を作成してください。",
      lastUserMessage: "という意図です",
      clarificationReply: "補足をもらえれば起票できます。",
      missingDecisionSummary: "task title が曖昧です。",
      threadParentIssueId: "AIC-970",
      relatedIssueIds: ["AIC-970"],
      recordedAt: clarificationRecordedAt,
    });
    await saveLastManagerAgentTurn(threadPaths, {
      recordedAt: "2026-03-23T04:06:30.000Z",
      intent: "create_work",
      pendingClarificationDecision: "continue_pending",
      pendingClarificationPersistence: "keep",
      pendingClarificationDecisionSummary: "前の create clarification への補足です。",
      missingQuerySnapshot: false,
    });

    const diagnostics = await buildManagerThreadDiagnostics({
      config: { ...config, workspaceDir },
      repositories,
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-diagnostics",
    });

    expect(diagnostics.threadKey).toBe("C0ALAMDRB9V:thread-diagnostics");
    expect(diagnostics.planningContext?.latestResolvedIssue?.issueId).toBe("AIC-970");
    expect(diagnostics.lastQueryContext).toMatchObject({
      kind: "what-should-i-do",
      issueIds: ["AIC-970"],
      shownIssueIds: ["AIC-970"],
      remainingIssueIds: [],
      totalItemCount: 1,
    });
    expect(diagnostics.pendingClarification).toMatchObject({
      intent: "create_work",
      threadParentIssueId: "AIC-970",
    });
    expect(diagnostics.lastAgentTurn).toMatchObject({
      intent: "create_work",
      pendingClarificationDecision: "continue_pending",
      pendingClarificationPersistence: "keep",
      missingQuerySnapshot: false,
    });
    expect(diagnostics.slackThreadContext.entries).toHaveLength(2);
    expect(diagnostics.ownerMapDiagnostics.unmappedSlackEntries).toHaveLength(0);
    expect(diagnostics.ownerMapDiagnostics.mappedSlackEntries).toBe(1);
  });

  it("builds issue diagnostics with followup and latest source", async () => {
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-19T04:10:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-issue-diagnostics",
        messageTs: "msg-seed-3",
      },
      messageFingerprint: "diag-issue-seed",
      childIssues: [
        { issueId: "AIC-970", title: "OPT社の社内チャネルへの招待依頼", kind: "execution" },
      ],
      planningReason: "single-issue",
      lastResolvedIssueId: "AIC-970",
      originalText: "招待依頼を追加する",
    });
    await writeFile(
      buildSystemPaths(workspaceDir).followupsFile,
      `${JSON.stringify([
        {
          issueId: "AIC-970",
          requestKind: "status",
          status: "awaiting-response",
          requestText: "最新状況を共有してください。",
          sourceChannelId: "C0ALAMDRB9V",
          sourceThreadTs: "thread-issue-diagnostics",
          sourceMessageTs: "msg-seed-3",
        },
      ], null, 2)}\n`,
      "utf8",
    );

    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-issue-diagnostics");
    await ensureThreadWorkspace(threadPaths);
    await appendThreadLog(threadPaths, {
      type: "user",
      ts: "msg-seed-3",
      threadTs: "thread-issue-diagnostics",
      userId: "U1",
      text: "招待依頼を追加する",
    });

    const diagnostics = await buildManagerIssueDiagnostics({
      config: { ...config, workspaceDir },
      repositories,
      issueId: "AIC-970",
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(diagnostics.issueContext?.issueId).toBe("AIC-970");
    expect(diagnostics.latestSource?.rootThreadTs).toBe("thread-issue-diagnostics");
    expect(diagnostics.followup?.requestKind).toBe("status");
    expect(diagnostics.slackThreadContext?.entries).toHaveLength(1);
    expect(diagnostics.linearIssue?.identifier).toBe("AIC-970");
  });
});
