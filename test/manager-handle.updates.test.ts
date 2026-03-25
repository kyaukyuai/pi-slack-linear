import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyManagerSignal,
  formatIssueSelectionReply,
  handleManagerMessage,
} from "../src/lib/manager.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
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

function stripTaskTitle(text: string): string {
  return text
    .trim()
    .replace(/^<@[^>]+>\s*/, "")
    .replace(/^\s*(?:[-*・•]\s+|\d+[.)]\s+)/, "")
    .replace(/(の)?(タスク|issue|Issue|イシュー|ticket|チケット)(を)?/g, " ")
    .replace(/(しておいて|やっておいて|追加して|作成して|作って|登録して|おいて|お願い(します)?|対応して|進めておいて|進めて)/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/を$/, "")
    .trim();
}

function extractExplicitTasks(text: string): Array<{ title: string; dueDate?: string; assigneeHint?: string }> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .filter((line) => /^\s*[-*・•]\s+/.test(line))
    .map((line) => ({ title: stripTaskTitle(line) }));
}

function defaultTaskPlan(input: { combinedRequest: string }): Record<string, unknown> {
  const text = input.combinedRequest;

  if (text.includes("期限は 2026-03-20 で、作業は")) {
    const children = extractExplicitTasks(text);
    return {
      action: "create",
      planningReason: "complex-request",
      parentTitle: "複雑な依頼",
      parentDueDate: "2026-03-20",
      children: children.map((child) => ({
        title: child.title,
        kind: "execution",
        dueDate: child.dueDate ?? undefined,
        assigneeHint: child.assigneeHint ?? undefined,
      })),
    };
  }

  const singleTitle = stripTaskTitle(text) || "Slack からの依頼";
  return {
    action: "create",
    planningReason: "single-issue",
    parentTitle: null,
    parentDueDate: undefined,
    children: [
      { title: singleTitle, kind: "execution", dueDate: undefined },
    ],
  };
}

function defaultMessageRouter(input: { messageText: string }) {
  const signal = classifyManagerSignal(input.messageText.trim());
  if (signal === "progress") {
    return { action: "update_progress", confidence: 0.9, reasoningSummary: "進捗更新です。" };
  }
  if (signal === "completed") {
    return { action: "update_completed", confidence: 0.9, reasoningSummary: "完了更新です。" };
  }
  if (signal === "blocked") {
    return { action: "update_blocked", confidence: 0.9, reasoningSummary: "blocked 更新です。" };
  }
  if (signal === "request") {
    return { action: "create_work", confidence: 0.9, reasoningSummary: "新規依頼です。" };
  }
  return {
    action: "conversation",
    conversationKind: "other",
    confidence: 0.6,
    reasoningSummary: "雑談として扱います。",
  };
}

function defaultManagerReply() {
  return { reply: "対応しました。" };
}

function loadThreadProjection(systemPaths: ReturnType<typeof buildSystemPaths>, threadKey: string) {
  return createFileBackedManagerRepositories(systemPaths).workgraph.project().then((projection) => projection.threads[threadKey]);
}

describe("handleManagerMessage update flows", () => {
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

  async function updatePolicy(patch: Record<string, unknown>): Promise<void> {
    const raw = await readFile(systemPaths.policyFile, "utf8");
    const current = JSON.parse(raw) as Record<string, unknown>;
    await writeFile(systemPaths.policyFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
  }

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-updates-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset().mockImplementation(async (input: { issueId: string; dueDate?: string }) => ({
      id: input.issueId,
      identifier: input.issueId,
      title: "updated",
      dueDate: input.dueDate,
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.assignLinearIssue.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearComment.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearProgressComment.mockReset().mockResolvedValue({ id: "comment-1", body: "ok" });
    linearMocks.addLinearRelation.mockReset().mockResolvedValue(undefined);
    linearMocks.getLinearIssue.mockReset().mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId,
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.markLinearIssueBlocked.mockReset().mockResolvedValue({
      issue: { id: "issue-1", identifier: "AIC-100", title: "blocked" },
      blockedStateApplied: true,
    });
    linearMocks.updateLinearIssueState.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-100",
      title: "done",
      relations: [],
      inverseRelations: [],
    });
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.listOpenLinearIssues.mockReset().mockImplementation(async (...args: unknown[]) => linearMocks.listRiskyLinearIssues(...args));

    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-updates",
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
      route: defaultMessageRouter,
      buildReply: defaultManagerReply,
    }));
    piSessionMocks.runManagerSystemTurn.mockReset().mockRejectedValue(new Error("manager system fallback"));
    piSessionMocks.runMessageRouterTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { messageText: string }) => defaultMessageRouter(input));
    piSessionMocks.runManagerReplyTurn.mockReset().mockImplementation(async () => defaultManagerReply());
    piSessionMocks.runTaskPlanningTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { combinedRequest: string }) => defaultTaskPlan(input));
    piSessionMocks.runResearchSynthesisTurn.mockReset();
    piSessionMocks.runFollowupResolutionTurn.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("updates a unique thread-linked issue when the user reports progress", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-110",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-110",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("進捗を反映しました。");
    expect(result.reply).toContain("AIC-110");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-110",
      expect.stringContaining("進捗です。原因は再現できています"),
      expect.any(Object),
    );

    const thread = await loadThreadProjection(systemPaths, "C0ALAMDRB9V:thread-progress");
    expect(thread).toMatchObject({
      lastResolvedIssueId: "AIC-110",
      issueStatuses: {
        "AIC-110": "progress",
      },
    });
  });

  it("updates the due date when the agent proposes a progress update with a new target date", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-38",
      identifier: "AIC-38",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-38",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-due-date",
        messageTs: "msg-1",
        userId: "U1",
        text: "OPT社の社内チャネルへの招待依頼を追加して",
      },
      new Date("2026-03-23T00:00:00.000Z"),
    );

    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-38",
      identifier: "AIC-38",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-38",
      dueDate: "2026-03-27",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "AIC-38 の期限を今週金曜に更新し、進捗として反映します。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "update_progress",
              confidence: 0.92,
              summary: "進捗更新と新しい完了目処の共有です。",
            },
          },
        },
        {
          toolName: "propose_update_issue_status",
          details: {
            proposal: {
              commandType: "update_issue_status",
              issueId: "AIC-38",
              signal: "progress",
              dueDate: "2026-03-27",
              reasonSummary: "今週を目処という表現から今週金曜を完了目標と判断しました。",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-38",
          signal: "progress",
          dueDate: "2026-03-27",
          reasonSummary: "今週を目処という表現から今週金曜を完了目標と判断しました。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "update_progress",
        confidence: 0.92,
        summary: "進捗更新と新しい完了目処の共有です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-due-date",
        messageTs: "msg-2",
        userId: "U1",
        text: "AIC-38 は今週を目処に完了させます",
      },
      new Date("2026-03-23T00:02:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("進捗を反映しました。");
    expect(result.reply).toContain("期限は 2026-03-27 として反映しました。");
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-38",
        dueDate: "2026-03-27",
      }),
      expect.any(Object),
    );

    const projection = await createFileBackedManagerRepositories(systemPaths).workgraph.project();
    expect(projection.issues["AIC-38"]).toMatchObject({
      dueDate: "2026-03-27",
      lastStatus: "progress",
    });
  });

  it("keeps status updates enabled when autoCreate is disabled", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-210",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-210",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-autocreate-off",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    await updatePolicy({
      autoCreate: false,
      autoStatusUpdate: true,
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-autocreate-off",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("進捗を反映しました。");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-210",
      expect.stringContaining("進捗です。原因は再現できています"),
      expect.any(Object),
    );
  });

  it("asks for an issue id when the thread maps to multiple issues for completion", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-120",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-120",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-121",
          title: "設計",
          url: "https://linear.app/kyaukyuai/issue/AIC-121",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-122",
          title: "実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-122",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-121" ? "設計" : issueId === "AIC-122" ? "実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    }));

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計\n- 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex",
        messageTs: "msg-2",
        userId: "U1",
        text: "終わりました",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("完了として反映しました。");
    expect(linearMocks.updateLinearIssueStateWithComment).toHaveBeenCalledWith(
      "AIC-122",
      "completed",
      expect.stringContaining("## Completion source"),
      expect.any(Object),
    );
  });

  it("prefers a matching child issue in a multi-issue thread", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-220",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-220",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-221",
          title: "設計",
          url: "https://linear.app/kyaukyuai/issue/AIC-221",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-222",
          title: "実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-222",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-221" ? "設計" : issueId === "AIC-222" ? "実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.updateLinearIssueStateWithComment.mockResolvedValueOnce({
      id: "child-1",
      identifier: "AIC-221",
      title: "設計",
      url: "https://linear.app/kyaukyuai/issue/AIC-221",
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-title-match",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計\n- 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-title-match",
        messageTs: "msg-2",
        userId: "U1",
        text: "設計は終わりました",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("完了として反映しました。");
    expect(result.reply).toContain("AIC-221");
    expect(linearMocks.updateLinearIssueStateWithComment).toHaveBeenCalledWith(
      "AIC-221",
      "completed",
      expect.stringContaining("## Completion source"),
      expect.any(Object),
    );
  });

  it("uses recent thread context to resolve generic progress updates to the right child issue", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-320",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-320",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-321",
          title: "設計整理",
          url: "https://linear.app/kyaukyuai/issue/AIC-321",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-322",
          title: "API 実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-322",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-321" ? "設計整理" : issueId === "AIC-322" ? "API 実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    }));
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-complex-recent-focus",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-complex-recent-focus", text: "API 実装を進めています" },
        { type: "assistant", ts: "2", threadTs: "thread-complex-recent-focus", text: "承知しました" },
        { type: "user", ts: "3", threadTs: "thread-complex-recent-focus", text: "進捗です" },
      ],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-recent-focus",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計整理\n- API 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-recent-focus",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("進捗を反映しました。");
    expect(result.reply).toContain("AIC-322");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-322",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("prefers a child with recent Linear progress comments for generic progress updates", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-420",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-420",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-421",
          title: "設計整理",
          url: "https://linear.app/kyaukyuai/issue/AIC-421",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-422",
          title: "API 実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-422",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-421" ? "設計整理" : issueId === "AIC-422" ? "API 実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      latestActionKind: issueId === "AIC-422" ? "progress" : "other",
      comments: issueId === "AIC-422"
        ? [{ id: "comment-1", body: "## Progress update\nAPI 実装の確認を進めています", createdAt: "2026-03-17T04:01:00.000Z" }]
        : [{ id: "comment-2", body: "## Slack source\n設計整理", createdAt: "2026-03-17T04:01:00.000Z" }],
      relations: [],
      inverseRelations: [],
    }));
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-linear-comment-focus",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-linear-comment-focus", text: "進捗です" },
      ],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-linear-comment-focus",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計整理\n- API 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-linear-comment-focus",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-422");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-422",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("asks for clarification instead of forcing a weak status match onto the latest child", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-500",
        title: "ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-500",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-501",
          title: "テスト環境でログインフローを実行しスクリーンショット付きで再現手順を記録する",
          url: "https://linear.app/kyaukyuai/issue/AIC-501",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-502",
          title: "直近のデプロイ履歴・設定変更履歴を確認し不具合発生タイミングと照合する",
          url: "https://linear.app/kyaukyuai/issue/AIC-502",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-501"
        ? "テスト環境でログインフローを実行しスクリーンショット付きで再現手順を記録する"
        : issueId === "AIC-502"
          ? "直近のデプロイ履歴・設定変更履歴を確認し不具合発生タイミングと照合する"
          : "ログイン画面の不具合",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      latestActionKind: issueId === "AIC-502" ? "progress" : "other",
      comments: issueId === "AIC-502"
        ? [{ id: "comment-1", body: "## Progress update\nデプロイ履歴を確認しています", createdAt: "2026-03-17T04:01:00.000Z" }]
        : [{ id: "comment-2", body: "## Slack source\n再現手順の確認", createdAt: "2026-03-17T04:01:00.000Z" }],
      relations: [],
      inverseRelations: [],
    }));
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-weak-routing",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-weak-routing", text: "ログイン画面の不具合を調査して" },
        { type: "assistant", ts: "2", threadTs: "thread-weak-routing", text: "AIC-501 と AIC-502 を作成しました" },
      ],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-weak-routing",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- テスト環境でログインフローを実行しスクリーンショット付きで再現手順を記録する\n- 直近のデプロイ履歴・設定変更履歴を確認し不具合発生タイミングと照合する\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-weak-routing",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています。次は API 仕様を確認します。本日中に更新します。",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("どの issue に進捗を反映するか、まだ決めきれていません。");
    expect(result.reply).toContain("AIC-501");
    expect(result.reply).toContain("AIC-502");
    expect(result.reply).toContain("どれにも当てはまらなければ、`新規 task` と返してください。");
    expect(linearMocks.addLinearProgressComment).not.toHaveBeenCalled();
  });

  it("marks a thread-linked issue as blocked", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-130",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-130",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-blocked",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-blocked",
        messageTs: "msg-2",
        userId: "U1",
        text: "blocked です。API 仕様待ちです",
      },
      new Date("2026-03-17T04:10:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("blocked を反映しました。");
    expect(linearMocks.markLinearIssueBlocked).toHaveBeenCalledWith(
      "AIC-130",
      expect.stringContaining("API 仕様待ちです"),
      expect.any(Object),
    );
  });

  it("includes latest action labels in ambiguity replies", async () => {
    const reply = formatIssueSelectionReply("progress", [
      { issueId: "AIC-431", title: "設計整理", latestActionLabel: "進捗", focusReason: "直近 thread focus" },
      { issueId: "AIC-432", title: "設計検証", latestActionLabel: "blocked", focusReason: "最新 intake entry" },
    ]);

    expect(reply).toContain("- AIC-431 設計整理。最新の動きは 進捗。候補に出した理由は 直近 thread focus。");
    expect(reply).toContain("- AIC-432 設計検証。最新の動きは blocked。候補に出した理由は 最新 intake entry。");
    expect(reply).toContain("どれにも当てはまらなければ、`新規 task` と返してください。");
  });
});
