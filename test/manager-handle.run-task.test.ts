import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleManagerMessage } from "../src/lib/manager.js";
import { loadPendingManagerClarification } from "../src/lib/pending-manager-clarification.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";
import { createDefaultTestManagerAgentTurn } from "./helpers/default-manager-agent-mock.js";

const linearMocks = vi.hoisted(() => ({
  searchLinearIssues: vi.fn(),
  createManagedLinearIssue: vi.fn(),
  createManagedLinearIssueBatch: vi.fn(),
  updateManagedLinearIssue: vi.fn(),
  assignLinearIssue: vi.fn(),
  addLinearComment: vi.fn(),
  addLinearProgressComment: vi.fn(),
  addLinearRelation: vi.fn(),
  getLinearIssue: vi.fn(),
  markLinearIssueBlocked: vi.fn(),
  updateLinearIssueState: vi.fn(),
  updateLinearIssueStateWithComment: vi.fn(),
  listOpenLinearIssues: vi.fn(),
  listRiskyLinearIssues: vi.fn(),
}));

const slackContextMocks = vi.hoisted(() => ({
  getSlackThreadContext: vi.fn(),
  getRecentChannelContext: vi.fn(),
}));

const webResearchMocks = vi.hoisted(() => ({
  webSearchFetch: vi.fn(),
  webFetchUrl: vi.fn(),
}));

const notionMocks = vi.hoisted(() => ({
  archiveNotionPage: vi.fn(),
  createNotionAgendaPage: vi.fn(),
  updateNotionPage: vi.fn(),
}));

const piSessionMocks = vi.hoisted(() => ({
  runManagerAgentTurn: vi.fn(),
  runManagerSystemTurn: vi.fn(),
  runMessageRouterTurn: vi.fn(),
  runManagerReplyTurn: vi.fn(),
  runTaskPlanningTurn: vi.fn(),
  runResearchSynthesisTurn: vi.fn(),
  runFollowupResolutionTurn: vi.fn(),
}));

vi.mock("../src/lib/linear.js", () => ({
  searchLinearIssues: linearMocks.searchLinearIssues,
  createManagedLinearIssue: linearMocks.createManagedLinearIssue,
  createManagedLinearIssueBatch: linearMocks.createManagedLinearIssueBatch,
  updateManagedLinearIssue: linearMocks.updateManagedLinearIssue,
  assignLinearIssue: linearMocks.assignLinearIssue,
  addLinearComment: linearMocks.addLinearComment,
  addLinearProgressComment: linearMocks.addLinearProgressComment,
  addLinearRelation: linearMocks.addLinearRelation,
  getLinearIssue: linearMocks.getLinearIssue,
  markLinearIssueBlocked: linearMocks.markLinearIssueBlocked,
  updateLinearIssueState: linearMocks.updateLinearIssueState,
  updateLinearIssueStateWithComment: linearMocks.updateLinearIssueStateWithComment,
  listOpenLinearIssues: linearMocks.listOpenLinearIssues,
  listRiskyLinearIssues: linearMocks.listRiskyLinearIssues,
}));

vi.mock("../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
  getRecentChannelContext: slackContextMocks.getRecentChannelContext,
}));

vi.mock("../src/lib/web-research.js", () => ({
  webSearchFetch: webResearchMocks.webSearchFetch,
  webFetchUrl: webResearchMocks.webFetchUrl,
}));

vi.mock("../src/lib/notion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/notion.js")>("../src/lib/notion.js");
  return {
    ...actual,
    archiveNotionPage: notionMocks.archiveNotionPage,
    createNotionAgendaPage: notionMocks.createNotionAgendaPage,
    updateNotionPage: notionMocks.updateNotionPage,
  };
});

vi.mock("../src/lib/pi-session.js", () => ({
  runManagerAgentTurn: piSessionMocks.runManagerAgentTurn,
  runManagerSystemTurn: piSessionMocks.runManagerSystemTurn,
  runMessageRouterTurn: piSessionMocks.runMessageRouterTurn,
  runManagerReplyTurn: piSessionMocks.runManagerReplyTurn,
  runTaskPlanningTurn: piSessionMocks.runTaskPlanningTurn,
  runResearchSynthesisTurn: piSessionMocks.runResearchSynthesisTurn,
  runFollowupResolutionTurn: piSessionMocks.runFollowupResolutionTurn,
}));

function defaultRunTaskRouter(input: { messageText: string }) {
  const text = input.messageText.trim();
  if (/(?:AIC-\d+|[A-Z]+-\d+).*(?:進めて|実行して)|(?:この issue|このタスク).*(?:進めて|実行して)/.test(text)) {
    return {
      action: "run_task" as const,
      confidence: 0.95,
      reasoningSummary: "既存 issue の実行依頼です。",
    };
  }
  return {
    action: "conversation" as const,
    conversationKind: "other" as const,
    confidence: 0.6,
    reasoningSummary: "雑談として扱います。",
  };
}

function defaultReplyBuilder() {
  return {
    reply: "対応しました。",
  };
}

describe("handleManagerMessage run_task flow", () => {
  let workspaceDir: string;
  let systemPaths: ReturnType<typeof buildSystemPaths>;

  const config = {
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
    anthropicApiKey: undefined,
    linearApiKey: "lin_api_test",
    linearWorkspace: "kyaukyuai",
    linearTeamKey: "AIC",
    notionApiToken: "secret_test",
    notionAgendaParentPageId: "parent-page-1",
    botModel: "claude-sonnet-4-5",
    botThinkingLevel: "minimal" as const,
    botMaxOutputTokens: undefined,
    botRetryMaxRetries: 1,
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
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-run-task-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset();
    linearMocks.assignLinearIssue.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearComment.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearProgressComment.mockReset().mockResolvedValue({ id: "comment-1", body: "ok" });
    linearMocks.addLinearRelation.mockReset().mockResolvedValue(undefined);
    linearMocks.getLinearIssue.mockReset().mockImplementation(async (issueId: string) => ({
      id: `issue-${issueId}`,
      identifier: issueId,
      title: issueId,
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.markLinearIssueBlocked.mockReset();
    linearMocks.updateLinearIssueState.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset();
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.listOpenLinearIssues.mockReset().mockResolvedValue([]);

    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-run-task",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
    notionMocks.archiveNotionPage.mockReset();
    notionMocks.createNotionAgendaPage.mockReset();
    notionMocks.updateNotionPage.mockReset();

    piSessionMocks.runManagerAgentTurn.mockReset().mockImplementation(createDefaultTestManagerAgentTurn({
      config: { ...config, workspaceDir },
      systemPaths,
      linearMocks: {
        listOpenLinearIssues: linearMocks.listOpenLinearIssues,
        searchLinearIssues: linearMocks.searchLinearIssues,
        getLinearIssue: linearMocks.getLinearIssue,
      },
      slackContextMocks: {
        getSlackThreadContext: slackContextMocks.getSlackThreadContext,
      },
      route: defaultRunTaskRouter,
      buildReply: defaultReplyBuilder,
    }));
    piSessionMocks.runManagerSystemTurn.mockReset().mockRejectedValue(new Error("manager system fallback"));
    piSessionMocks.runMessageRouterTurn.mockReset();
    piSessionMocks.runManagerReplyTurn.mockReset();
    piSessionMocks.runTaskPlanningTurn.mockReset();
    piSessionMocks.runResearchSynthesisTurn.mockReset();
    piSessionMocks.runFollowupResolutionTurn.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("executes run_task requests against an explicit existing issue", async () => {
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-110",
      identifier: "AIC-110",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-110",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-run-task-explicit",
        messageTs: "msg-run-task-explicit-1",
        userId: "U1",
        text: "AIC-110 を進めて",
      },
      new Date("2026-03-24T02:10:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-110 はまだ実行の起点が無かったため、まず進め方コメントを追加しました。");
    expect(result.reply).toContain("必要ならこの thread で続きの進捗を共有してください。");
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-110",
      expect.stringContaining("## AI execution"),
      expect.any(Object),
    );
    expect(result.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "run_task",
      taskExecutionDecision: "execute",
      taskExecutionTargetIssueIdentifier: "AIC-110",
    });
  });

  it("returns a concrete noop reason for completed run_task targets", async () => {
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-111",
      identifier: "AIC-111",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-111",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-done", name: "Done", type: "completed" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-run-task-completed",
        messageTs: "msg-run-task-completed-1",
        userId: "U1",
        text: "AIC-111 を進めて",
      },
      new Date("2026-03-24T02:11:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-111 を確認しましたが、いま実行できる manager action はありません。");
    expect(result.reply).toContain("対象 issue はすでに完了状態です。");
    expect(result.reply).toContain("状態変更・コメント追加・Notion更新などの次の操作を短く指定してください。");
    expect(linearMocks.addLinearComment).not.toHaveBeenCalled();
    expect(result.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "run_task",
      taskExecutionDecision: "noop",
      taskExecutionTargetIssueIdentifier: "AIC-111",
      taskExecutionSummary: "対象 issue はすでに完了状態です。",
    });
  });

  it("stores a run_task clarification when the target issue is ambiguous", async () => {
    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-run-task-clarify",
        messageTs: "msg-run-task-clarify-1",
        userId: "U1",
        text: "この issue を進めて",
      },
      new Date("2026-03-24T02:12:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("`AIC-123` のように issue ID を添えてもう一度送ってください。");
    expect(linearMocks.addLinearComment).not.toHaveBeenCalled();
    expect(result.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "run_task",
      taskExecutionDecision: "noop",
    });

    await expect(
      loadPendingManagerClarification(
        buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-run-task-clarify"),
        new Date("2026-03-24T02:13:00.000Z"),
      ),
    ).resolves.toMatchObject({
      intent: "run_task",
      missingDecisionSummary: "run_task の対象 issue を確認するため、issue ID の補足待ちです。",
    });
  });

  it("falls back to run_task action clarification when an explicit issue execution request is misclassified as query", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "AIC-52 は先ほど作成したタスクです。In Progress に移すことでしょうか？",
      toolCalls: [],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "inspect-work",
        summary: "Inspect AIC-52 to understand what run means in this context.",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-run-task-misclassified",
        messageTs: "msg-run-task-misclassified-1",
        userId: "U1",
        text: "AIC-52 を実行して",
      },
      new Date("2026-03-24T08:39:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-52 に対して何を実行したいかを安全に確定できないため");
    expect(result.reply).toContain("状態変更・コメント追加・Notion更新");
    expect(result.reply).not.toContain("一覧や優先順位を安全に判断できない");
    expect(result.diagnostics?.agent).toMatchObject({
      source: "fallback",
      technicalFailure: "manager agent explicit run_task misclassified as query",
    });

    await expect(
      loadPendingManagerClarification(
        buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-run-task-misclassified"),
        new Date("2026-03-24T08:40:00.000Z"),
      ),
    ).resolves.toMatchObject({
      intent: "run_task",
      lastUserMessage: "AIC-52 を実行して",
      missingDecisionSummary: "manager agent explicit run_task misclassified as query",
    });
  });
});
