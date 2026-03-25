import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyManagerQuery,
  classifyManagerSignal,
  fingerprintText,
  handleManagerMessage,
} from "../src/lib/manager.js";
import { loadPendingManagerClarification } from "../src/lib/pending-manager-clarification.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
import { recordPlanningOutcome } from "../src/state/workgraph/recorder.js";
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

  if (text.includes("来週のリリースに向けた対応を進めておいて") && !text.includes("API レート制限の確認")) {
    return {
      action: "clarify",
      clarificationQuestion: [
        "起票前に確認したい点があります。 対象は 来週のリリースに向けた対応 です。",
        "- 期限を確認したいです。いつまでに完了したいか教えてください。例: 2026-03-20 / 今日中 / 明日",
        "- 進め方を固めたいです。完了条件か、分けたい作業を 1-3 点で教えてください。",
        "返答をもらえれば、その内容を取り込んで Linear に起票します。",
      ].join("\n\n"),
      clarificationReasons: ["due_date", "execution_plan"],
    };
  }

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

  if (text.includes("期限は 2026-03-20 で、作業は")) {
    const children = extractExplicitTasks(text);
    return {
      action: "create",
      planningReason: "complex-request",
      parentTitle: text.includes("来週のリリースに向けた対応") ? "来週のリリースに向けた対応" : "複雑な依頼",
      parentDueDate: "2026-03-20",
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
  if (
    input.threadContext?.intakeStatus === "created"
    && !input.threadContext.parentIssueId
    && (input.threadContext.childIssueIds?.length ?? 0) === 1
    && /(ではなく|そうではなく|意図としては|つまり|言い換えると|そういう意味です|という意図です)/.test(text)
  ) {
    return { action: "create_work", confidence: 0.9, reasoningSummary: "同じ thread の訂正です。" };
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

describe("handleManagerMessage intake and clarification flow", () => {
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
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-intake-clarification-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset().mockImplementation(async (input: { issueId: string; description?: string }) => ({
      id: input.issueId,
      identifier: input.issueId,
      title: "updated",
      description: input.description,
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.assignLinearIssue.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearComment.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearProgressComment.mockReset().mockResolvedValue({ id: "comment-1", body: "ok" });
    linearMocks.addLinearRelation.mockReset().mockResolvedValue(undefined);
    linearMocks.getLinearIssue.mockReset().mockImplementation(async (issueId: string) => ({
      id: `issue-${issueId}`,
      identifier: issueId,
      title: issueId === "AIC-110" ? "ログイン画面の不具合修正" : issueId,
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
    linearMocks.updateLinearIssueState.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-100",
      title: "done",
    });
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
      rootThreadTs: "thread-clarify",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
    notionMocks.archiveNotionPage.mockReset().mockResolvedValue({
      id: "notion-page-1",
      object: "page",
      title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
      url: "https://www.notion.so/page-1",
      inTrash: true,
      raw: {},
    });
    notionMocks.createNotionAgendaPage.mockReset().mockResolvedValue({
      id: "notion-page-1",
      object: "page",
      title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
      url: "https://www.notion.so/page-1",
      createdTime: "2026-03-24T00:00:00.000Z",
    });
    notionMocks.updateNotionPage.mockReset().mockResolvedValue({
      id: "notion-page-1",
      object: "page",
      title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
      url: "https://www.notion.so/page-1",
      raw: {},
    });
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

  it("asks for clarification first, then creates parent and child issues from follow-up details", async () => {
    const first = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-clarify",
        messageTs: "msg-1",
        userId: "U1",
        text: "来週のリリースに向けた対応を進めておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(first.handled).toBe(true);
    expect(first.reply).toContain("起票前に確認したい点があります");
    expect(first.reply).toContain("期限を確認したいです");
    expect(first.reply).toContain("進め方を固めたいです");
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.createManagedLinearIssueBatch).not.toHaveBeenCalled();

    let thread = await loadThreadProjection("C0ALAMDRB9V:thread-clarify");
    expect(thread).toMatchObject({
      intakeStatus: "needs-clarification",
      pendingClarification: true,
    });

    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-100",
        title: "来週のリリースに向けた対応",
        url: "https://linear.app/kyaukyuai/issue/AIC-100",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-101",
          title: "API レート制限の確認",
          url: "https://linear.app/kyaukyuai/issue/AIC-101",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-102",
          title: "修正対応",
          url: "https://linear.app/kyaukyuai/issue/AIC-102",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    const second = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-clarify",
        messageTs: "msg-2",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- API レート制限の確認\n- 修正対応\nに分けて進めて",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(second.handled).toBe(true);
    expect(second.reply).toContain("この依頼は Linear に登録しておきました。");
    expect(second.reply).toContain("AIC-100");
    expect(second.reply).toContain("親は <https://linear.app/kyaukyuai/issue/AIC-100|AIC-100 来週のリリースに向けた対応> です。");
    expect(second.reply).toContain("子 task は <https://linear.app/kyaukyuai/issue/AIC-101|AIC-101 API レート制限の確認> と <https://linear.app/kyaukyuai/issue/AIC-102|AIC-102 修正対応> です。");
    expect(second.reply).not.toContain("暫定で kyaukyuai に寄せています");
    expect(second.reply).toContain("この thread で進捗・完了・blocked を続けてください。");
    expect(second.reply).not.toContain("URL:");

    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledTimes(1);
    expect(linearMocks.assignLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.addLinearRelation).toHaveBeenCalledWith("AIC-101", "blocks", "AIC-102", expect.any(Object));

    const projection = await createFileBackedManagerRepositories(systemPaths).workgraph.project();
    expect(projection.threads["C0ALAMDRB9V:thread-clarify"]).toMatchObject({
      intakeStatus: "created",
      parentIssueId: "AIC-100",
      childIssueIds: ["AIC-101", "AIC-102"],
      lastResolvedIssueId: "AIC-102",
    });
    expect(projection.issues["AIC-101"]).toMatchObject({
      parentIssueId: "AIC-100",
      kind: "execution",
    });
  });

  it("continues a pending clarification from workgraph even if the intake ledger entry is missing", async () => {
    const repositories = createFileBackedManagerRepositories(systemPaths);

    const first = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-clarify-workgraph",
        messageTs: "msg-1",
        userId: "U1",
        text: "来週のリリースに向けた対応を進めておいて",
      },
      repositories,
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(first.handled).toBe(true);
    expect(first.reply).toContain("起票前に確認したい点があります");

    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-10",
        identifier: "AIC-110",
        title: "来週のリリースに向けた対応",
        url: "https://linear.app/kyaukyuai/issue/AIC-110",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-11",
          identifier: "AIC-111",
          title: "API レート制限の確認",
          url: "https://linear.app/kyaukyuai/issue/AIC-111",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-12",
          identifier: "AIC-112",
          title: "修正対応",
          url: "https://linear.app/kyaukyuai/issue/AIC-112",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    piSessionMocks.runManagerAgentTurn.mockImplementationOnce(async (_config, _paths, input) => {
      expect(input.pendingClarification).toMatchObject({
        intent: "create_work",
        originalUserMessage: "来週のリリースに向けた対応を進めておいて",
      });
      expect(input.text).toBe("期限は 2026-03-20 で、作業は\n- API レート制限の確認\n- 修正対応\nに分けて進めて");
      return {
        reply: "来週のリリースに向けた対応を親 issue として、子 task に分けて起票します。",
        toolCalls: [
          {
            toolName: "report_pending_clarification_decision",
            details: {
              pendingClarificationDecision: {
                decision: "continue_pending",
                persistence: "keep",
                summary: "前の create clarification への補足です。",
              },
            },
          },
          {
            toolName: "report_manager_intent",
            details: {
              intentReport: {
                intent: "create_work",
                confidence: 0.95,
                summary: "補足を受けて親子 task を起票します。",
              },
            },
          },
        ],
        proposals: [
          {
            commandType: "create_issue_batch",
            planningReason: "complex-request",
            threadParentHandling: "ignore",
            duplicateHandling: "create-new",
            reasonSummary: "実行単位に分けて進める task 群です。",
            parent: {
              title: "来週のリリースに向けた対応",
              description: "リリース前対応の親 issue。",
              assigneeMode: "assign",
              assignee: "y.kakui",
              dueDate: "2026-03-20",
            },
            children: [
              {
                title: "API レート制限の確認",
                description: "API レート制限を確認する。",
                assigneeMode: "assign",
                assignee: "y.kakui",
                dueDate: "2026-03-20",
              },
              {
                title: "修正対応",
                description: "必要な修正を進める。",
                assigneeMode: "assign",
                assignee: "y.kakui",
                dueDate: "2026-03-20",
              },
            ],
          },
        ],
        invalidProposalCount: 0,
        intentReport: {
          intent: "create_work",
          confidence: 0.95,
          summary: "補足を受けて親子 task を起票します。",
        },
        pendingClarificationDecision: {
          decision: "continue_pending",
          persistence: "keep",
          summary: "前の create clarification への補足です。",
        },
      };
    });

    const second = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-clarify-workgraph",
        messageTs: "msg-2",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- API レート制限の確認\n- 修正対応\nに分けて進めて",
      },
      repositories,
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(second.handled).toBe(true);
    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: expect.objectContaining({
          title: "来週のリリースに向けた対応",
        }),
      }),
      expect.any(Object),
    );
  });

  it("detects duplicate intake from workgraph even if the intake ledger entry is missing", async () => {
    const repositories = createFileBackedManagerRepositories(systemPaths);

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-dup-1",
      identifier: "AIC-150",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-150",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    const first = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-duplicate-workgraph",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      repositories,
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(first.handled).toBe(true);
    const second = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-duplicate-workgraph",
        messageTs: "msg-2",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      repositories,
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(second.handled).toBe(true);
    expect(second.reply).toContain("この依頼は既に取り込まれています。");
    expect(second.reply).toContain("AIC-150");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(1);
  });

  it("creates a single issue without duplicating parent and child labels in the reply", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-38",
      identifier: "AIC-38",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-38",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-single-issue",
        messageTs: "msg-1",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("この依頼は Linear に登録しておきました。");
    expect(result.reply).toContain("対象は <https://linear.app/kyaukyuai/issue/AIC-38|AIC-38 OPT社の社内チャネルへの招待依頼> です。");
    expect(result.reply).not.toContain("子 task は");
    expect(linearMocks.createManagedLinearIssueBatch).not.toHaveBeenCalled();
  });

  it("continues a create request after a safety-only clarification turn", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-880",
      identifier: "AIC-880",
      title: "Slack の mrkdwn 表示崩れを修正する",
      url: "https://linear.app/kyaukyuai/issue/AIC-880",
      relations: [],
      inverseRelations: [],
    });

    piSessionMocks.runManagerAgentTurn
      .mockRejectedValueOnce(new Error("agent failure"))
      .mockImplementationOnce(async (_config, _paths, input) => {
        expect(input.pendingClarification).toMatchObject({
          intent: "create_work",
          originalUserMessage: expect.stringContaining("箇条書きや太文字が slack に反映されず"),
        });
        return {
          reply: "Slack の表示崩れを直す task として起票します。",
          toolCalls: [
            {
              toolName: "report_pending_clarification_decision",
              details: {
                pendingClarificationDecision: {
                  decision: "continue_pending",
                  persistence: "keep",
                  summary: "前の create clarification への補足です。",
                },
              },
            },
            {
              toolName: "report_manager_intent",
              details: {
                intentReport: {
                  intent: "create_work",
                  confidence: 0.95,
                  summary: "表示不具合の修正 task 起票です。",
                },
              },
            },
          ],
          proposals: [{
            commandType: "create_issue",
            planningReason: "single-issue",
            issue: {
              title: "Slack の mrkdwn 表示崩れを修正する",
              description: "箇条書きや太文字が Slack でそのまま表示される問題を修正する。",
              assigneeMode: "leave-unassigned",
            },
            threadParentHandling: "ignore",
            duplicateHandling: "create-new",
            reasonSummary: "表示崩れの修正 task が必要です。",
          }],
          invalidProposalCount: 0,
          intentReport: {
            intent: "create_work",
            confidence: 0.95,
            summary: "表示不具合の修正 task 起票です。",
          },
          pendingClarificationDecision: {
            decision: "continue_pending",
            persistence: "keep",
            summary: "前の create clarification への補足です。",
          },
        };
      });

    const first = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-create-clarification",
        messageTs: "msg-1",
        userId: "U1",
        text: "箇条書きや太文字が slack に反映されず、そのまま表示されているので、それを修正するタスクを作成してください。",
      },
      new Date("2026-03-23T03:24:00.000Z"),
    );

    expect(first.reply).toContain("次の返信はこの thread の続きとして扱います");

    const pending = await loadPendingManagerClarification(
      buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-create-clarification"),
      new Date("2026-03-23T03:25:00.000Z"),
    );
    expect(pending).toMatchObject({
      intent: "create_work",
    });

    const second = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-create-clarification",
        messageTs: "msg-2",
        userId: "U1",
        text: "という意図です",
      },
      new Date("2026-03-23T03:25:00.000Z"),
    );

    expect(second.handled).toBe(true);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Slack の mrkdwn 表示崩れを修正する",
      }),
      expect.any(Object),
    );
    expect(second.reply).toContain("task として起票します。");
  });

  it("corrects the latest single-issue intake in place instead of creating a new issue", async () => {
    const repositories = createFileBackedManagerRepositories(systemPaths);
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-25T00:04:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-intake-correction",
        messageTs: "msg-create-1",
      },
      messageFingerprint: "金澤さんの ChatGPT プロジェクトの招待依頼のタスクを作成して",
      childIssues: [
        {
          issueId: "AIC-60",
          title: "金澤さんをChatGPTプロジェクトに招待する",
          kind: "execution",
        },
      ],
      planningReason: "single-issue",
      lastResolvedIssueId: "AIC-60",
      originalText: "金澤さんの ChatGPT プロジェクトの招待依頼のタスクを作成して",
    });

    piSessionMocks.runMessageRouterTurn.mockResolvedValueOnce({
      action: "create_work",
      confidence: 0.95,
      reasoningSummary: "同じ依頼 thread の訂正です。",
    });
    piSessionMocks.runTaskPlanningTurn.mockResolvedValueOnce({
      action: "update_existing",
      targetIssueId: "AIC-60",
      title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
      description: "unused by code-side regeneration",
    });
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-60",
      identifier: "AIC-60",
      title: "金澤さんをChatGPTプロジェクトに招待する",
      url: "https://linear.app/kyaukyuai/issue/AIC-60",
      state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
      relations: [],
      inverseRelations: [],
    });
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-60",
      identifier: "AIC-60",
      title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
      url: "https://linear.app/kyaukyuai/issue/AIC-60",
      state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-intake-correction",
        messageTs: "msg-correction-1",
        userId: "U1",
        text: "金澤さんを招待するのではなく、金澤さんのプロジェクトに角井を招待してもらうタスクです。",
      },
      new Date("2026-03-25T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-60",
        title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
        description: expect.stringContaining("訂正:"),
      }),
      expect.any(Object),
    );
    expect(result.reply).toContain("既存 issue を修正しました");

    const projection = await repositories.workgraph.project();
    expect(projection.threads["C0ALAMDRB9V:thread-intake-correction"]).toMatchObject({
      lastResolvedIssueId: "AIC-60",
      latestFocusIssueId: "AIC-60",
      messageFingerprint: fingerprintText("金澤さんを招待するのではなく、金澤さんのプロジェクトに角井を招待してもらうタスクです。"),
    });
  });

  it("clarifies instead of auto-correcting when the latest thread issue already has progress", async () => {
    const repositories = createFileBackedManagerRepositories(systemPaths);
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-25T00:04:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-intake-correction-progressed",
        messageTs: "msg-create-1",
      },
      messageFingerprint: "seed correction issue",
      childIssues: [
        {
          issueId: "AIC-70",
          title: "誤った task 名",
          kind: "execution",
        },
      ],
      planningReason: "single-issue",
      lastResolvedIssueId: "AIC-70",
      originalText: "seed correction issue",
    });
    await repositories.workgraph.append([
      {
        type: "issue.progressed",
        occurredAt: "2026-03-25T00:05:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-intake-correction-progressed",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-intake-correction-progressed",
        sourceMessageTs: "msg-progress-1",
        issueId: "AIC-70",
        textSnippet: "進捗です",
      },
    ]);

    piSessionMocks.runMessageRouterTurn.mockImplementation(async () => ({
      action: "create_work",
      confidence: 0.95,
      reasoningSummary: "同じ依頼 thread の訂正です。",
    }));
    piSessionMocks.runTaskPlanningTurn.mockImplementation(async () => ({
      action: "update_existing",
      targetIssueId: "AIC-70",
      title: "正しい task 名",
      description: "unused by code-side regeneration",
    }));

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-intake-correction-progressed",
        messageTs: "msg-correction-1",
        userId: "U1",
        text: "そうではなく、別の意図です。",
      },
      new Date("2026-03-25T01:06:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("対象 issue ID を明示してください");
    expect(linearMocks.updateManagedLinearIssue).not.toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "AIC-70", title: "正しい task 名" }),
      expect.anything(),
    );
  });

  it("explains the pending clarification state when the user asks what is happening", async () => {
    piSessionMocks.runManagerAgentTurn.mockRejectedValueOnce(new Error("agent failure"));

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-create-status-question",
        messageTs: "msg-1",
        userId: "U1",
        text: "箇条書きや太文字が slack に反映されず、そのまま表示されているので、それを修正するタスクを作成してください。",
      },
      new Date("2026-03-23T03:24:00.000Z"),
    );

    piSessionMocks.runManagerAgentTurn.mockRejectedValueOnce(new Error("agent failure"));

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-create-status-question",
        messageTs: "msg-2",
        userId: "U1",
        text: "どういう状況ですか？",
      },
      new Date("2026-03-23T03:25:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("前の依頼を task として確定するための補足待ちです");
  });

  it("does not treat an unrelated Notion query as a continuation of a pending create clarification", async () => {
    piSessionMocks.runManagerAgentTurn.mockRejectedValueOnce(new Error("agent failure"));

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-unrelated-after-clarify",
        messageTs: "msg-1",
        userId: "U1",
        text: "箇条書きや太文字が slack に反映されず、そのまま表示されているので、それを修正するタスクを作成してください。",
      },
      new Date("2026-03-23T03:24:00.000Z"),
    );

    piSessionMocks.runManagerAgentTurn.mockImplementationOnce(async (_config, _paths, input) => {
      expect(input.pendingClarification).toMatchObject({
        intent: "create_work",
      });
      return {
        reply: "Notion の内容を確認します。",
        toolCalls: [
          {
            toolName: "report_pending_clarification_decision",
            details: {
              pendingClarificationDecision: {
                decision: "new_request",
                persistence: "clear",
                summary: "pending clarification はありますが今回の発話は新しい query です。",
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
                replySummary: "Notion の内容を確認します。",
                scope: "team",
              },
            },
          },
          {
            toolName: "report_manager_intent",
            details: {
              intentReport: {
                intent: "query",
                queryKind: "reference-material",
                queryScope: "team",
                confidence: 0.84,
                summary: "Notion の確認依頼です。",
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
          confidence: 0.84,
          summary: "Notion の確認依頼です。",
        },
        pendingClarificationDecision: {
          decision: "new_request",
          persistence: "clear",
          summary: "pending clarification はありますが今回の発話は新しい query です。",
        },
      };
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-unrelated-after-clarify",
        messageTs: "msg-2",
        userId: "U1",
        text: "Notion を確認して",
      },
      new Date("2026-03-23T03:25:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Notion の内容を確認します。");
  });
});
