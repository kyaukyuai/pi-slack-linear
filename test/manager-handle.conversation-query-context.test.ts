import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyManagerQuery,
  classifyManagerSignal,
  handleManagerMessage,
} from "../src/lib/manager.js";
import { loadThreadQueryContinuation } from "../src/lib/query-continuation.js";
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

function defaultTaskPlan(input: { combinedRequest: string }): Record<string, unknown> {
  const text = input.combinedRequest;
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

function defaultMessageRouter(input: {
  messageText: string;
  threadContext?: {
    pendingClarification?: boolean;
    intakeStatus?: string;
    parentIssueId?: string;
    childIssueIds?: string[];
  };
}) {
  const text = input.messageText.trim();
  if (/^(?:おはよう|こんにちは|こんばんは|お疲れさま|おつかれさま)(?:ございます)?[。！!？?]*$/.test(text)) {
    return {
      action: "conversation",
      conversationKind: "greeting",
      confidence: 0.95,
      reasoningSummary: "挨拶です。",
    };
  }

  if (/(?:notion|ノーション).*(?:database|データベース)|(?:database|データベース).*(?:notion|ノーション)/i.test(text)) {
    return {
      action: "query",
      queryKind: "reference-material",
      queryScope: /(?:その|この).*(?:database|データベース)|一覧を(?:見て|確認)/i.test(text) ? "thread-context" : "team",
      confidence: 0.9,
      reasoningSummary: "Notion database の参照依頼です。",
    };
  }

  const queryKind = classifyManagerQuery(text);
  if (queryKind) {
    const queryScope = /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/.test(text)
      ? "self"
      : /(?:この件|その件|他には|ほかに|他の)/.test(text) || queryKind === "inspect-work" || queryKind === "recommend-next-step"
        ? "thread-context"
        : "team";
    return {
      action: "query",
      queryKind,
      queryScope,
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

function renderMockIssue(issue: Record<string, unknown>): string {
  const identifier = String(issue.identifier ?? "");
  const title = String(issue.title ?? "");
  return `${identifier} ${title}`.trim();
}

function defaultManagerReply(input: {
  kind: string;
  conversationKind?: string;
  facts?: Record<string, unknown>;
}) {
  const facts = input.facts ?? {};

  if (input.kind === "conversation") {
    if (input.conversationKind === "greeting") {
      return {
        reply: "こんばんは。確認したいことや進めたい task があれば、そのまま送ってください。",
      };
    }
    return {
      reply: "必要なことがあれば、そのまま続けて送ってください。状況確認でも task の相談でも対応します。",
    };
  }

  if (input.kind === "list-active") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    if (items.length === 0) {
      return { reply: "いま active な task は見当たりません。" };
    }
    return {
      reply: [
        "タスク一覧を確認しました。",
        ...items.map((item) => `- ${renderMockIssue(item)}`),
        "気になる issue があれば、issue ID を返してもらえれば詳細も追えます。",
      ].join("\n"),
    };
  }

  if (input.kind === "list-today") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    const viewerDisplayLabel = typeof facts.viewerDisplayLabel === "string" ? facts.viewerDisplayLabel : undefined;
    return {
      reply: [
        viewerDisplayLabel ? `${viewerDisplayLabel} を基準に、今日優先して見たい task を整理しました。` : "今日優先して見たい task を整理しました。",
        ...items.map((item) => `- ${renderMockIssue(item)}`),
        facts.viewerMappingMissing ? "ownerMap.slackUserId を入れると自分向けに寄せられます。" : undefined,
      ].filter(Boolean).join("\n"),
    };
  }

  if (input.kind === "what-should-i-do") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    const top = items[0];
    const viewerDisplayLabel = typeof facts.viewerDisplayLabel === "string" ? facts.viewerDisplayLabel : undefined;
    return {
      reply: [
        top
          ? viewerDisplayLabel
            ? `今日まず手を付けるなら ${viewerDisplayLabel} の中では ${renderMockIssue(top)} から見るのがよさそうです。`
            : `今日まず手を付けるなら ${renderMockIssue(top)} から見るのがよさそうです。`
          : "いま着手中の task は見当たりません。",
        ...items.map((item) => `- ${renderMockIssue(item)}`),
        facts.viewerMappingMissing ? "ownerMap.slackUserId を入れると自分向けに寄せられます。" : undefined,
        "必要なら、このまま優先順位を一緒に絞ります。",
      ].filter(Boolean).join("\n"),
    };
  }

  if (input.kind === "inspect-work") {
    const issue = (facts.issue ?? {}) as Record<string, unknown>;
    return {
      reply: [
        `${renderMockIssue(issue)} の状況を確認しました。`,
        issue.state ? `状態は ${issue.state} です。` : undefined,
        issue.dueDate ? `期限は ${issue.dueDate} です。` : undefined,
        issue.priorityLabel ? `優先度は ${issue.priorityLabel} です。` : undefined,
      ].filter(Boolean).join(" "),
    };
  }

  if (input.kind === "search-existing") {
    const issues = Array.isArray(facts.issues) ? facts.issues as Array<Record<string, unknown>> : [];
    if (issues.length >= 2) {
      return {
        reply: [
          "近い既存 issue が複数見つかりました。",
          ...issues.map((issue) => `- ${renderMockIssue(issue)}`),
        ].join("\n"),
      };
    }
    if (issues.length === 1) {
      return { reply: `近い既存 issue が見つかりました。対象は ${renderMockIssue(issues[0])} です。` };
    }
    return { reply: "近い既存 issue はまだ見当たりませんでした。" };
  }

  if (input.kind === "recommend-next-step") {
    const issue = (facts.issue ?? {}) as Record<string, unknown>;
    return {
      reply: [
        `${renderMockIssue(issue)} について、次の一手を整理しました。`,
        typeof facts.recentThreadSummary === "string" ? facts.recentThreadSummary : undefined,
        typeof facts.recommendedAction === "string" ? facts.recommendedAction : undefined,
      ].filter(Boolean).join(" "),
    };
  }

  if (input.kind === "reference-material") {
    const referenceItems = Array.isArray(facts.referenceItems) ? facts.referenceItems as Array<Record<string, unknown>> : [];
    if (referenceItems.length === 0) {
      return { reply: "参照できる資料はまだ見当たりませんでした。" };
    }
    return {
      reply: [
        "参照できる資料を確認しました。",
        ...referenceItems.map((item) => `- ${String(item.title ?? item.id ?? "")}`),
      ].join("\n"),
    };
  }

  return { reply: "対応しました。" };
}

describe("handleManagerMessage conversation and query-context flow", () => {
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
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-conversation-query-"));
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
      rootThreadTs: "thread-query",
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
    piSessionMocks.runMessageRouterTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { messageText: string; threadContext?: { pendingClarification?: boolean } }) => defaultMessageRouter(input));
    piSessionMocks.runManagerReplyTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { kind: string; conversationKind?: string; facts?: Record<string, unknown> }) => defaultManagerReply(input));
    piSessionMocks.runTaskPlanningTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { combinedRequest: string }) => defaultTaskPlan(input));
    piSessionMocks.runResearchSynthesisTurn.mockReset();
    piSessionMocks.runFollowupResolutionTurn.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("handles greetings inside manager when the LLM router classifies them as conversation", async () => {
    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-conversation",
        messageTs: "msg-1",
        userId: "U1",
        text: "こんばんは",
      },
      new Date("2026-03-19T12:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("こんばんは。");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("returns a safety-only conversation reply when the manager agent fails technically", async () => {
    piSessionMocks.runManagerAgentTurn.mockRejectedValueOnce(new Error("agent failure"));

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-router-fallback",
        messageTs: "msg-1",
        userId: "U1",
        text: "こんばんは",
      },
      new Date("2026-03-19T12:01:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("こんばんは。");
    expect(result.diagnostics?.router).toMatchObject({
      source: "fallback",
      action: "conversation",
    });
    expect(result.diagnostics?.router.technicalFailure).toContain("agent failure");
  });

  it("returns a safety-only query reply when the manager agent fails technically", async () => {
    piSessionMocks.runManagerAgentTurn.mockRejectedValueOnce(new Error("agent failure"));

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-fallback",
        messageTs: "msg-1",
        userId: "U1",
        text: "今日やるべきタスクある？",
      },
      new Date("2026-03-19T12:02:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("issue ID か条件をもう少し具体的に教えてください");
  });

  it("passes stored reference-material items into the next follow-up turn", async () => {
    piSessionMocks.runManagerAgentTurn
      .mockResolvedValueOnce({
        reply: "参照できる Notion ページは 1 件です。",
        toolCalls: [
          {
            toolName: "report_manager_intent",
            details: {
              intentReport: {
                intent: "query",
                queryKind: "reference-material",
                queryScope: "team",
                confidence: 0.87,
                summary: "Notion の参照依頼です。",
              },
            },
          },
          {
            toolName: "report_query_snapshot",
            details: {
              querySnapshot: {
                issueIds: [],
                shownIssueIds: [],
                remainingIssueIds: [],
                totalItemCount: 0,
                referenceItems: [
                  {
                    id: "notion-page-1",
                    title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
                    url: "https://www.notion.so/notion-page-1",
                    source: "notion",
                  },
                ],
                replySummary: "参照できる Notion ページは 1 件です。",
                scope: "team",
              },
            },
          },
        ],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: "query",
          queryKind: "reference-material",
          queryScope: "team",
          confidence: 0.87,
          summary: "Notion の参照依頼です。",
        },
      })
      .mockImplementationOnce(async (_config: unknown, _paths: unknown, input: {
        lastQueryContext?: {
          kind: string;
          referenceItems?: Array<{ id: string; title?: string; source?: string }>;
        };
      }) => {
        expect(input.lastQueryContext).toMatchObject({
          kind: "reference-material",
          referenceItems: [
            {
              id: "notion-page-1",
              title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
              source: "notion",
            },
          ],
        });
        return {
          reply: "PoC 対象範囲として、金澤クローンを中心とした PoC 範囲の確認事項が記載されています。",
          toolCalls: [
            {
              toolName: "report_manager_intent",
              details: {
                intentReport: {
                  intent: "query",
                  queryKind: "reference-material",
                  queryScope: "thread-context",
                  confidence: 0.9,
                  summary: "直前の Notion ページの続きです。",
                },
              },
            },
            {
              toolName: "report_query_snapshot",
              details: {
                querySnapshot: {
                  issueIds: [],
                  shownIssueIds: [],
                  remainingIssueIds: [],
                  totalItemCount: 0,
                  referenceItems: [
                    {
                      id: "notion-page-1",
                      title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
                      url: "https://www.notion.so/notion-page-1",
                      source: "notion",
                    },
                  ],
                  replySummary: "PoC 対象範囲の要点を返しました。",
                  scope: "thread-context",
                },
              },
            },
          ],
          proposals: [],
          invalidProposalCount: 0,
          intentReport: {
            intent: "query",
            queryKind: "reference-material",
            queryScope: "thread-context",
            confidence: 0.9,
            summary: "直前の Notion ページの続きです。",
          },
        };
      });

    const first = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-followup",
        messageTs: "msg-notion-1",
        userId: "U1",
        text: "Notion を確認して",
      },
      new Date("2026-03-23T08:19:00.000Z"),
    );

    expect(first.reply).toContain("Notion ページ");
    await expect(
      loadThreadQueryContinuation(buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-notion-followup")),
    ).resolves.toMatchObject({
      kind: "reference-material",
      referenceItems: [
        {
          id: "notion-page-1",
          title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
        },
      ],
    });

    const followup = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-followup",
        messageTs: "msg-notion-2",
        userId: "U1",
        text: "PoC 対象範囲を詳しく見て",
      },
      new Date("2026-03-23T08:20:00.000Z"),
    );

    expect(followup.reply).toContain("PoC 対象範囲");
  });

  it("searches for existing issues before new creation when asked conversationally", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-801",
      identifier: "AIC-801",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-801",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-search-existing",
        messageTs: "msg-1",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );
    piSessionMocks.runTaskPlanningTurn.mockClear();

    linearMocks.searchLinearIssues.mockResolvedValueOnce([
      {
        id: "issue-900",
        identifier: "AIC-900",
        title: "OPT社の社内チャネルへの招待依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-900",
        assignee: { id: "user-2", displayName: "t.tahira" },
        state: { id: "state-started", name: "Started", type: "started" },
        dueDate: "2026-03-22",
        relations: [],
        inverseRelations: [],
      },
      {
        id: "issue-901",
        identifier: "AIC-901",
        title: "OPT社の社内チャネル参加依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-901",
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        relations: [],
        inverseRelations: [],
      },
    ]);

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-search-existing",
        messageTs: "msg-2",
        userId: "U1",
        text: "既存 issue あったっけ？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.searchLinearIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "OPT社の社内チャネルへの招待依頼",
        limit: 5,
      }),
      expect.any(Object),
    );
    expect(result.reply).toContain("近い既存 issue が複数見つかりました。");
    expect(result.reply).toContain("AIC-900");
    expect(result.reply).toContain("AIC-901");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("uses the manager agent as the primary path for conversational replies", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "こんばんは。確認したいことがあれば、そのまま続けてください。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "conversation",
              confidence: 0.98,
              summary: "挨拶です。",
            },
          },
        },
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "conversation",
        confidence: 0.98,
        summary: "挨拶です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agent-conversation",
        messageTs: "msg-agent-1",
        userId: "U1",
        text: "こんばんは",
      },
      new Date("2026-03-19T06:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("こんばんは。");
    expect(result.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "conversation",
      proposalCount: 0,
    });
    expect(piSessionMocks.runMessageRouterTurn).not.toHaveBeenCalled();
  });

  it("stores the last query context and passes it into a follow-up query turn", async () => {
    piSessionMocks.runManagerAgentTurn
      .mockResolvedValueOnce({
        reply: "今日まず見るなら AIC-38 の状況を確認するのがよさそうです。",
        toolCalls: [
          {
            toolName: "report_manager_intent",
            details: {
              intentReport: {
                intent: "query",
                queryKind: "what-should-i-do",
                queryScope: "team",
                confidence: 0.94,
                summary: "優先順位の確認です。",
              },
            },
          },
          {
            toolName: "report_query_snapshot",
            details: {
              querySnapshot: {
                issueIds: ["AIC-38"],
                shownIssueIds: ["AIC-38"],
                remainingIssueIds: ["AIC-39"],
                totalItemCount: 2,
                replySummary: "今日まず見るなら AIC-38 の状況を確認するのがよさそうです。",
                scope: "team",
              },
            },
          },
        ],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: "query",
          queryKind: "what-should-i-do",
          queryScope: "team",
          confidence: 0.94,
          summary: "優先順位の確認です。",
        },
      })
      .mockImplementationOnce(async (_config: unknown, _paths: unknown, input: {
        lastQueryContext?: {
          kind: string;
          scope: string;
          issueIds: string[];
          shownIssueIds: string[];
          remainingIssueIds: string[];
          totalItemCount: number;
          userMessage: string;
        };
      }) => {
        expect(input.lastQueryContext).toMatchObject({
          kind: "what-should-i-do",
          scope: "team",
          issueIds: ["AIC-38"],
          shownIssueIds: ["AIC-38"],
          remainingIssueIds: ["AIC-39"],
          totalItemCount: 2,
          userMessage: "今日やるべきタスクある？",
        });
        return {
          reply: "他に動いている task は今のところありません。見ておくべきものは AIC-38 だけです。",
          toolCalls: [
            {
              toolName: "report_manager_intent",
              details: {
                intentReport: {
                  intent: "query",
                  queryKind: "list-active",
                  queryScope: "thread-context",
                  confidence: 0.92,
                  summary: "直前の一覧の続きです。",
                },
              },
            },
            {
              toolName: "report_query_snapshot",
              details: {
                querySnapshot: {
                  issueIds: ["AIC-38"],
                  shownIssueIds: ["AIC-38"],
                  remainingIssueIds: [],
                  totalItemCount: 1,
                  replySummary: "他に動いている task は今のところありません。見ておくべきものは AIC-38 だけです。",
                  scope: "thread-context",
                },
              },
            },
          ],
          proposals: [],
          invalidProposalCount: 0,
          intentReport: {
            intent: "query",
            queryKind: "list-active",
            queryScope: "thread-context",
            confidence: 0.92,
            summary: "直前の一覧の続きです。",
          },
        };
      });

    const first = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-continuation",
        messageTs: "msg-query-1",
        userId: "U1",
        text: "今日やるべきタスクある？",
      },
      new Date("2026-03-23T07:54:00.000Z"),
    );

    expect(first.reply).toContain("AIC-38");

    const followup = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-continuation",
        messageTs: "msg-query-2",
        userId: "U1",
        text: "他にはどのようなタスクがある？",
      },
      new Date("2026-03-23T07:55:00.000Z"),
    );

    expect(followup.reply).toContain("AIC-38");
    expect(followup.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "query",
      queryKind: "list-active",
      queryScope: "thread-context",
    });
  });

  it("returns a safety reply when the agent omits a required query snapshot", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "今日まず見るなら AIC-38 の状況を確認するのがよさそうです。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "query",
              queryKind: "what-should-i-do",
              queryScope: "team",
              confidence: 0.94,
              summary: "優先順位の確認です。",
            },
          },
        },
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "what-should-i-do",
        queryScope: "team",
        confidence: 0.94,
        summary: "優先順位の確認です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-missing-snapshot",
        messageTs: "msg-query-missing-snapshot",
        userId: "U1",
        text: "今日やるべきタスクある？",
      },
      new Date("2026-03-23T07:54:00.000Z"),
    );

    expect(result.reply).toBe("いまは一覧や優先順位を安全に判断できないため、issue ID か条件をもう少し具体的に教えてください。");
    expect(result.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "query",
      missingQuerySnapshot: true,
    });
    await expect(
      loadThreadQueryContinuation(buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-query-missing-snapshot")),
    ).resolves.toBeUndefined();
  });
});
