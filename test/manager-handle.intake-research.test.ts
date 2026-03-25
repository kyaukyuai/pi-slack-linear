import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyManagerQuery,
  classifyManagerSignal,
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
    .replace(/(を)?(調査|確認|検証|比較|リサーチ|洗い出し|調べ)(しておいて|して|お願いします|お願い)?/g, " ")
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

  const numbered = lines.filter((line) => /^\d+[.)]\s+/.test(line) && !/一覧$/.test(line));
  if (numbered.length >= 2) {
    return numbered.map((line) => {
      const metadata = line.match(/[（(]([^()（）]+)[)）]\s*$/)?.[1] ?? "";
      const title = stripTaskTitle(line.replace(/\s*[（(][^()（）]+[)）]\s*$/, ""));
      const dueDate = metadata.match(/期限[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1];
      const assigneeHint = metadata.match(/担当[:：]\s*([^,，]+)/)?.[1]?.trim();
      return { title, dueDate, assigneeHint };
    });
  }

  const bullets = lines
    .filter((line) => /^\s*[-*・•]\s+/.test(line))
    .map((line) => ({ title: stripTaskTitle(line) }));
  return bullets;
}

function defaultTaskPlan(input: { combinedRequest: string }): Record<string, unknown> {
  const text = input.combinedRequest;

  if (text.includes("OPT社と金澤クローンAI開発の契約を締結する必要があります")) {
    return {
      action: "create",
      planningReason: "complex-request",
      parentTitle: "OPT社と金澤クローンAI開発の契約を締結する必要があります",
      parentDueDate: undefined,
      children: [
        { title: "ドラフト作成", kind: "execution", dueDate: undefined },
        { title: "OPT 田平さんへ契約書確認依頼", kind: "execution", dueDate: undefined },
      ],
    };
  }

  if (text.includes("3. タスク一覧")) {
    const children = extractExplicitTasks(text);
    return {
      action: "create",
      planningReason: "complex-request",
      parentTitle: "2ヶ月版の見積もり書作成 ほか1件",
      parentDueDate: undefined,
      children: children.map((child) => ({
        title: child.title,
        kind: "execution",
        dueDate: child.dueDate ?? undefined,
        assigneeHint: child.assigneeHint ?? undefined,
      })),
    };
  }

  if (text.includes("ログイン画面の不具合を調査して")) {
    const parentTitle = text.includes("修正") ? "ログイン画面の不具合修正" : "ログイン画面の不具合";
    return {
      action: "create",
      planningReason: "research-first",
      parentTitle,
      parentDueDate: undefined,
      children: [
        { title: `調査: ${parentTitle}`, kind: "research", dueDate: undefined },
      ],
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
  const text = input.messageText.trim();
  const queryKind = classifyManagerQuery(text);
  if (queryKind) {
    return {
      action: "query",
      queryKind,
      queryScope: "team",
      confidence: 0.9,
      reasoningSummary: "query と判断しました。",
    };
  }

  const signal = classifyManagerSignal(text);
  if (signal === "progress") {
    return { action: "update_progress", confidence: 0.9, reasoningSummary: "進捗更新です。" };
  }
  if (signal === "completed") {
    return { action: "update_completed", confidence: 0.9, reasoningSummary: "完了更新です。" };
  }
  if (signal === "blocked") {
    return { action: "update_blocked", confidence: 0.9, reasoningSummary: "blocked 更新です。" };
  }
  return { action: "create_work", confidence: 0.9, reasoningSummary: "新規依頼です。" };
}

function defaultManagerReply() {
  return { reply: "対応しました。" };
}

describe("handleManagerMessage intake and research flow", () => {
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
    botThinkingLevel: "minimal",
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

  async function loadThreadProjection(threadKey: string) {
    return createFileBackedManagerRepositories(systemPaths).workgraph.project().then((projection) => projection.threads[threadKey]);
  }

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-intake-research-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-1",
      title: "updated",
      relations: [],
      inverseRelations: [],
    });
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
      rootThreadTs: "thread-intake-research",
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
    piSessionMocks.runResearchSynthesisTurn.mockReset().mockResolvedValue({
      findings: ["関連情報の洗い出しを開始しました。"],
      uncertainties: ["スコープや対処方針の確定が必要なら、この thread で詰めます。"],
      nextActions: [],
    });
    piSessionMocks.runFollowupResolutionTurn.mockReset().mockResolvedValue({
      answered: false,
      confidence: 0.3,
      reasoningSummary: "要求に対する返答としてはまだ不十分です。",
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("imports numbered task lists without mangling titles and applies inline assignee metadata", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-200",
        title: "2ヶ月版の見積もり書作成 ほか1件",
        url: "https://linear.app/kyaukyuai/issue/AIC-200",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-201",
          title: "2ヶ月版の見積もり書作成",
          url: "https://linear.app/kyaukyuai/issue/AIC-201",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-202",
          title: "4月・5月の2ヶ月間でのクローン成果物の作成",
          url: "https://linear.app/kyaukyuai/issue/AIC-202",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-list-import",
        messageTs: "msg-1",
        userId: "U1",
        text: `3. タスク一覧
1. 2ヶ月版の見積もり書作成（担当：角井 勇哉, 期限：未定）
2. 4月・5月の2ヶ月間でのクローン成果物の作成（担当：角井 勇哉, 期限：2026-05-31）`,
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("この依頼は Linear に登録しておきました。");
    expect(result.reply).toContain("親は <https://linear.app/kyaukyuai/issue/AIC-200|AIC-200 2ヶ月版の見積もり書作成 ほか1件> です。");
    expect(result.reply).toContain("子 task は <https://linear.app/kyaukyuai/issue/AIC-201|AIC-201 2ヶ月版の見積もり書作成> と <https://linear.app/kyaukyuai/issue/AIC-202|AIC-202 4月・5月の2ヶ月間でのクローン成果物の作成> です。");
    expect(result.reply).not.toContain("暫定で kyaukyuai に寄せています");

    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: expect.objectContaining({
          title: "2ヶ月版の見積もり書作成 ほか1件",
          dueDate: undefined,
        }),
        children: [
          expect.objectContaining({
            title: "2ヶ月版の見積もり書作成",
            assignee: "角井 勇哉",
            dueDate: undefined,
          }),
          expect.objectContaining({
            title: "4月・5月の2ヶ月間でのクローン成果物の作成",
            assignee: "角井 勇哉",
            dueDate: "2026-05-31",
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
  });

  it("uses the lead narrative line as the parent and skips creating a duplicate child task", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-34",
        title: "OPT社と金澤クローンAI開発の契約を締結する必要があります",
        url: "https://linear.app/kyaukyuai/issue/AIC-34",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-35",
          title: "ドラフト作成",
          url: "https://linear.app/kyaukyuai/issue/AIC-35",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-36",
          title: "OPT 田平さんへ契約書確認依頼",
          url: "https://linear.app/kyaukyuai/issue/AIC-36",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-contract-parent",
        messageTs: "msg-1",
        userId: "U1",
        text: `OPT社と金澤クローンAI開発の契約を締結する必要があります。
契約書のドラフト版の作成依頼済み
ドラフト版作成後、OPT 田平さんに確認依頼する必要あり`,
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("親は <https://linear.app/kyaukyuai/issue/AIC-34|AIC-34 OPT社と金澤クローンAI開発の契約を締結する必要があります> です。");
    expect(result.reply).toContain("子 task は <https://linear.app/kyaukyuai/issue/AIC-35|AIC-35 ドラフト作成> と <https://linear.app/kyaukyuai/issue/AIC-36|AIC-36 OPT 田平さんへ契約書確認依頼> です。");

    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: expect.objectContaining({
          title: "OPT社と金澤クローンAI開発の契約を締結する必要があります",
        }),
        children: [
          expect.objectContaining({
            title: "ドラフト作成",
          }),
          expect.objectContaining({
            title: "OPT 田平さんへ契約書確認依頼",
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it("writes a structured research comment for research-first requests", async () => {
    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "parent-1",
        identifier: "AIC-140",
        title: "ログイン画面の不具合調査",
        url: "https://linear.app/kyaukyuai/issue/AIC-140",
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-1",
        identifier: "AIC-141",
        title: "調査: ログイン画面の不具合調査",
        url: "https://linear.app/kyaukyuai/issue/AIC-141",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      });
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "related-1",
          identifier: "AIC-050",
          title: "過去のログイン不具合",
          state: { id: "state-1", name: "Started", type: "started" },
          relations: [],
          inverseRelations: [],
        },
      ]);
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-research",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-research", text: "ログイン画面の不具合を調査して" },
      ],
    });
    slackContextMocks.getRecentChannelContext.mockResolvedValue([
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "another-thread",
        entries: [{ type: "user", ts: "2", threadTs: "another-thread", text: "別件の文脈" }],
      },
    ]);
    webResearchMocks.webSearchFetch.mockResolvedValue([
      { title: "Login troubleshooting", url: "https://example.com/login", snippet: "Search snippet" },
    ]);
    webResearchMocks.webFetchUrl.mockResolvedValue({
      url: "https://example.com/login",
      title: "Login troubleshooting",
      snippet: "Fetched snippet",
    });
    piSessionMocks.runResearchSynthesisTurn.mockResolvedValue({
      findings: ["関連 issue として AIC-050 過去のログイン不具合 を確認しました。"],
      uncertainties: ["スコープや対処方針の確定が必要なら、この thread で詰めます。"],
      nextActions: [{ title: "API 仕様の確認", purpose: "API の差分を確認する", confidence: 0.82 }],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("調査内容を Linear に残しました。");
    expect(result.reply).toContain("いま分かっているのは、関連 issue として AIC-050 過去のログイン不具合 を確認しました。");
    expect(result.reply).toContain("まだ未確定なのは、スコープや対処方針の確定が必要なら、この thread で詰めます。");
    expect(result.reply).toContain("次に進める候補は「API 仕様の確認」です。");
    expect(result.reply).not.toContain("調べた範囲:");
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-141",
      expect.stringContaining("### Web results"),
      expect.any(Object),
    );
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-141",
        description: expect.stringContaining("関連 issue として AIC-050 過去のログイン不具合 を確認しました。"),
      }),
      expect.any(Object),
    );
  });

  it("creates follow-up child issues when research yields concrete next actions", async () => {
    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "parent-1",
        identifier: "AIC-240",
        title: "ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-240",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-1",
        identifier: "AIC-241",
        title: "調査: ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-241",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-2",
        identifier: "AIC-242",
        title: "API 仕様の確認",
        url: "https://linear.app/kyaukyuai/issue/AIC-242",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-3",
        identifier: "AIC-243",
        title: "修正方針の整理",
        url: "https://linear.app/kyaukyuai/issue/AIC-243",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      });
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-research-followups",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-research-followups", text: "ログイン画面の不具合を調査して" },
        { type: "assistant", ts: "2", threadTs: "thread-research-followups", text: "- API 仕様の確認\n- 修正方針の整理" },
      ],
    });
    piSessionMocks.runResearchSynthesisTurn.mockResolvedValue({
      findings: ["API 仕様の確認と修正方針の整理が必要です。"],
      uncertainties: ["仕様の確定が必要です。"],
      nextActions: [
        { title: "API 仕様の確認", purpose: "API 差分を洗い出す", confidence: 0.88 },
        { title: "修正方針の整理", purpose: "修正方針を具体化する", confidence: 0.81 },
      ],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research-followups",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("次に進める候補として 2 件の task を追加しています。");
    expect(result.reply).toContain("子 task は <https://linear.app/kyaukyuai/issue/AIC-242|AIC-242 API 仕様の確認> と <https://linear.app/kyaukyuai/issue/AIC-243|AIC-243 修正方針の整理> です。");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(4);

    const thread = await loadThreadProjection("C0ALAMDRB9V:thread-research-followups");
    expect(thread?.childIssueIds).toEqual(["AIC-241", "AIC-242", "AIC-243"]);
  });

  it("reuses an existing issue as the parent for research requests", async () => {
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([
        {
          id: "parent-research",
          identifier: "AIC-16",
          title: "調査: ログイン画面の不具合を調査して",
          url: "https://linear.app/kyaukyuai/issue/AIC-16",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "parent-existing",
          identifier: "AIC-11",
          title: "ログイン画面の不具合修正",
          url: "https://linear.app/kyaukyuai/issue/AIC-11",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ])
      .mockResolvedValueOnce([]);

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "child-1",
      identifier: "AIC-150",
      title: "調査: ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-150",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });
    piSessionMocks.runResearchSynthesisTurn.mockResolvedValue({
      findings: ["既存 issue 配下で調査すべきです。"],
      uncertainties: ["詳細な対処方針は未確定です。"],
      nextActions: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research-existing",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("調査 task は <https://linear.app/kyaukyuai/issue/AIC-150|AIC-150 調査: ログイン画面の不具合修正> で、親は <https://linear.app/kyaukyuai/issue/AIC-11|AIC-11 ログイン画面の不具合修正> です。");
    expect(result.reply).toContain("必要になれば、この thread から実行 task を追加できます。");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(1);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: "AIC-11",
        title: "調査: ログイン画面の不具合",
      }),
      expect.any(Object),
    );
    expect(linearMocks.assignLinearIssue).not.toHaveBeenCalled();

    const thread = await loadThreadProjection("C0ALAMDRB9V:thread-research-existing");
    expect(thread).toMatchObject({
      parentIssueId: "AIC-11",
      childIssueIds: ["AIC-150"],
    });
  });

  it("does not create follow-up child issues from request text when synthesis has no next actions", async () => {
    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "parent-1",
        identifier: "AIC-340",
        title: "ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-340",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-1",
        identifier: "AIC-341",
        title: "調査: ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-341",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      });
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    piSessionMocks.runResearchSynthesisTurn.mockRejectedValueOnce(new Error("synthesis failed"));
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-research-fallback",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-research-fallback", text: "ログイン画面の不具合を調査して。API 仕様の確認と修正方針の整理が必要です。" },
      ],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research-fallback",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して。API 仕様の確認と修正方針の整理が必要です。",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).not.toContain("追加 task を");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(2);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-341",
        description: expect.stringContaining("## 次アクション"),
      }),
      expect.any(Object),
    );

    const thread = await loadThreadProjection("C0ALAMDRB9V:thread-research-fallback");
    expect(thread?.childIssueIds).toEqual(["AIC-341"]);
  });
});
