import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHeartbeatReviewDecision,
  buildManagerReview,
  classifyManagerQuery,
  classifyManagerSignal,
  formatIssueSelectionReply,
  handleManagerMessage,
} from "../src/lib/manager.js";
import { loadPendingManagerClarification } from "../src/lib/pending-manager-clarification.js";
import { loadThreadQueryContinuation } from "../src/lib/query-continuation.js";
import { ensureManagerStateFiles, loadFollowupsLedger } from "../src/lib/manager-state.js";
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

function defaultMessageRouter(input: { messageText: string; threadContext?: { pendingClarification?: boolean } }) {
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

function makeActiveIssue(overrides: Record<string, unknown> & { identifier: string; title: string }) {
  return {
    id: `issue-${overrides.identifier}`,
    url: `https://linear.app/kyaukyuai/issue/${overrides.identifier}`,
    assignee: { id: "user-1", displayName: "y.kakui" },
    state: { id: "state-started", name: "Started", type: "started" },
    relations: [],
    inverseRelations: [],
    ...overrides,
  };
}

describe("handleManagerMessage clarification flow", () => {
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
    workspaceDir: "",
    linearWebhookEnabled: false,
    linearWebhookPublicUrl: undefined,
    linearWebhookSecret: undefined,
    linearWebhookPort: 8787,
    linearWebhookPath: "/hooks/linear",
    heartbeatIntervalMin: 30,
    heartbeatActiveLookbackHours: 24,
    schedulerPollSec: 30,
    logLevel: "info" as const,
  };

  async function updatePolicy(patch: Record<string, unknown>): Promise<void> {
    const raw = await readFile(systemPaths.policyFile, "utf8");
    const current = JSON.parse(raw) as Record<string, unknown>;
    await writeFile(systemPaths.policyFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
  }

  async function updateOwnerMap(patch: Record<string, unknown>): Promise<void> {
    const raw = await readFile(systemPaths.ownerMapFile, "utf8");
    const current = JSON.parse(raw) as Record<string, unknown>;
    await writeFile(systemPaths.ownerMapFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
  }

  async function loadThreadProjection(threadKey: string) {
    return createFileBackedManagerRepositories(systemPaths).workgraph.project().then((projection) => projection.threads[threadKey]);
  }

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-manager-"));
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
    linearMocks.getLinearIssue.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-110",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-110",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });
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

  it("lists active tasks for query-style task list requests", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValueOnce([
      makeActiveIssue({
        identifier: "AIC-501",
        title: "OPT社の社内チャネルへの招待依頼",
        dueDate: "2026-03-20",
        priority: 2,
        priorityLabel: "High",
      }),
      makeActiveIssue({
        identifier: "AIC-502",
        title: "契約書ドラフトの確認",
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
    ]);

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-active",
        messageTs: "msg-1",
        userId: "U1",
        text: "タスク一覧を確認して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("タスク一覧を確認しました。");
    expect(result.reply).toContain("AIC-501");
    expect(result.reply).toContain("AIC-502");
    expect(result.reply).toContain("気になる issue があれば");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
  });

  it("answers today and prioritization queries without sending them to intake", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      makeActiveIssue({
        identifier: "AIC-601",
        title: "今日中にOPT社へ確認事項を送る",
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
      makeActiveIssue({
        identifier: "AIC-602",
        title: "ドラフト作成",
        dueDate: "2026-03-20",
        priority: 2,
        priorityLabel: "High",
      }),
      makeActiveIssue({
        identifier: "AIC-603",
        title: "来週レビュー用のメモ整理",
        priority: 3,
        priorityLabel: "Medium",
        updatedAt: "2026-03-18T00:00:00.000Z",
      }),
    ]);

    const today = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-today",
        messageTs: "msg-1",
        userId: "U1",
        text: "今日のタスク一覧を確認して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(today.handled).toBe(true);
    expect(today.reply).toContain("今日優先して見たい task を整理しました。");
    expect(today.reply).toContain("AIC-601");
    expect(today.reply).toContain("AIC-602");

    const shouldDo = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-query-priority",
        messageTs: "msg-2",
        userId: "U1",
        text: "今日やるべきタスクある？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(shouldDo.handled).toBe(true);
    expect(shouldDo.reply).toContain("今日まず手を付けるなら");
    expect(shouldDo.reply).toContain("AIC-601");
    expect(shouldDo.reply).toContain("必要なら、このまま優先順位を一緒に絞ります。");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("prefers the viewer's assigned work for today and prioritization queries when owner mapping exists", async () => {
    await updateOwnerMap({
      entries: [
        {
          id: "kyaukyuai",
          domains: ["default"],
          keywords: [],
          linearAssignee: "y.kakui",
          slackUserId: "U1",
          primary: true,
        },
      ],
    });

    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      makeActiveIssue({
        identifier: "AIC-611",
        title: "自分の担当 task",
        assignee: { id: "user-1", displayName: "y.kakui" },
        dueDate: "2026-03-20",
        priority: 2,
        priorityLabel: "High",
      }),
      makeActiveIssue({
        identifier: "AIC-612",
        title: "他メンバーの urgent task",
        assignee: { id: "user-2", displayName: "t.tahira" },
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
    ]);

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-my-work-query",
        messageTs: "msg-1",
        userId: "U1",
        text: "今日やるべきタスクある？",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("y.kakui さんの担当");
    expect(result.reply).toContain("AIC-611");
    expect(result.reply).not.toContain("AIC-612");
  });

  it("mentions missing Slack owner mapping when personalized prioritization cannot be applied", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValueOnce([
      makeActiveIssue({
        identifier: "AIC-613",
        title: "チーム全体の urgent task",
        assignee: { id: "user-2", displayName: "t.tahira" },
        dueDate: "2026-03-19",
        priority: 1,
        priorityLabel: "Urgent",
      }),
    ]);

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-my-work-unmapped",
        messageTs: "msg-1",
        userId: "U2",
        text: "自分の今日やるべきタスクある？",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("ownerMap.slackUserId");
    expect(result.reply).toContain("AIC-613");
  });

  it("inspects the status of a thread-linked issue for conversational status questions", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-701",
      identifier: "AIC-701",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-701",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-21",
      priority: 2,
      priorityLabel: "High",
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect",
        messageTs: "msg-1",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );
    piSessionMocks.runTaskPlanningTurn.mockClear();

    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-701",
      identifier: "AIC-701",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-701",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-21",
      priority: 2,
      priorityLabel: "High",
      cycle: { id: "cycle-1", name: "Sprint 3" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect",
        messageTs: "msg-2",
        userId: "U1",
        text: "この件どうなってる？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-701");
    expect(result.reply).toContain("状況を確認しました。");
    expect(result.reply).toContain("状態は Started です。");
    expect(result.reply).toContain("期限は 2026-03-21 です。");
    expect(result.reply).toContain("優先度は High です。");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("uses recent thread context to disambiguate inspect queries in a multi-issue thread", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-90",
        identifier: "AIC-910",
        title: "来週のリリースに向けた対応",
        url: "https://linear.app/kyaukyuai/issue/AIC-910",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-91",
          identifier: "AIC-911",
          title: "API レート制限の確認",
          url: "https://linear.app/kyaukyuai/issue/AIC-911",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-92",
          identifier: "AIC-912",
          title: "修正対応",
          url: "https://linear.app/kyaukyuai/issue/AIC-912",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect-disambiguation",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- API レート制限の確認\n- 修正対応\nに分けて進めて",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );
    piSessionMocks.runTaskPlanningTurn.mockClear();

    slackContextMocks.getSlackThreadContext.mockResolvedValueOnce({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-inspect-disambiguation",
      entries: [
        { type: "assistant", text: "まずは AIC-911 API レート制限の確認 を見ます" },
        { type: "user", text: "了解、API レート制限の確認から進めます" },
      ],
    });
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "child-91",
      identifier: "AIC-911",
      title: "API レート制限の確認",
      url: "https://linear.app/kyaukyuai/issue/AIC-911",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-20",
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-inspect-disambiguation",
        messageTs: "msg-2",
        userId: "U1",
        text: "この件どうなってる？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-911");
    expect(result.reply).not.toContain("AIC-912 の状況");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
  });

  it("recommends the next step for a thread-linked issue using issue state and thread context", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-720",
      identifier: "AIC-720",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-720",
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
        rootThreadTs: "thread-next-step",
        messageTs: "msg-1",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-19T01:00:00.000Z"),
    );
    piSessionMocks.runTaskPlanningTurn.mockClear();

    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-next-step",
      entries: [
        { type: "assistant", text: "招待先を確認したら、そのまま依頼してください。" },
        { type: "user", text: "OPT社に投げる文面の下書きまではできています" },
      ],
    });
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-720",
      identifier: "AIC-720",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/kyaukyuai/issue/AIC-720",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-started", name: "Started", type: "started" },
      dueDate: "2026-03-21",
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-next-step",
        messageTs: "msg-2",
        userId: "U1",
        text: "この件次どう進める？",
      },
      new Date("2026-03-19T01:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("次の一手を整理しました。");
    expect(result.reply).toContain("AIC-720");
    expect(result.reply).toContain("下書きまではできています");
    expect(result.reply).toContain("次は今の進捗を 1 行で返すか");
    expect(piSessionMocks.runTaskPlanningTurn).not.toHaveBeenCalled();
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

    const thread = await loadThreadProjection("C0ALAMDRB9V:thread-progress");
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
          assignee: { id: "user-1", displayName: "角井 勇哉" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-202",
          title: "4月・5月の2ヶ月間でのクローン成果物の作成",
          url: "https://linear.app/kyaukyuai/issue/AIC-202",
          assignee: { id: "user-1", displayName: "角井 勇哉" },
          dueDate: "2026-05-31",
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

  it("adds one explicit follow-up to reviews and suppresses the same issue in heartbeat", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-300",
      title: "期限超過のタスク",
      url: "https://linear.app/kyaukyuai/issue/AIC-300",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });
    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-review-followup",
        messageTs: "msg-review-1",
        userId: "U1",
        text: "期限超過のタスクを対応しておいて",
      },
      new Date("2026-03-17T00:30:00.000Z"),
    );

    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-300",
        title: "期限超過のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        priorityLabel: "Urgent",
        cycle: {
          id: "cycle-42",
          number: 42,
          name: "Sprint 42",
        },
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);

    const morning = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T01:00:00.000Z"),
    );

    expect(morning?.text).toContain("おはようございます。今朝の確認で、優先して見てほしい点があります。");
    expect(morning?.text).toContain("AIC-300");
    expect(morning?.text).toContain("優先度: Urgent");
    expect(morning?.text).toContain("Cycle: Sprint 42");
    expect(morning?.issueLines?.[0]?.riskSummary).toContain("優先度: Urgent");
    expect(morning?.issueLines?.[0]?.riskSummary).toContain("Cycle: Sprint 42");
    expect(morning?.followup).toEqual(expect.objectContaining({
      issueId: "AIC-300",
      request: "現在の進捗と次アクション、次回更新予定を共有してください。",
      requestKind: "status",
      acceptableAnswerHint: "進捗 / 次アクション / 次回更新予定",
      source: expect.objectContaining({
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-review-followup",
        sourceMessageTs: "msg-review-1",
      }),
    }));

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-300",
        lastCategory: "overdue",
      }),
    ]));

    const heartbeat = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "heartbeat",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    expect(heartbeat).toBeUndefined();
  });

  it("resolves an awaiting follow-up when the same issue receives a progress update", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-301",
      title: "期限超過のタスク",
      url: "https://linear.app/kyaukyuai/issue/AIC-301",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-followup-resolve",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限超過のタスクを対応しておいて",
      },
      new Date("2026-03-17T00:30:00.000Z"),
    );

    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-301",
        title: "期限超過のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T01:00:00.000Z"),
    );
    linearMocks.getLinearIssue.mockImplementationOnce(async () => ({
      id: "issue-1",
      identifier: "AIC-301",
      title: "期限超過のタスク",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    })).mockImplementationOnce(async () => ({
      id: "issue-1",
      identifier: "AIC-301",
      title: "期限超過のタスク",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
      comments: [
        {
          id: "comment-1",
          body: "## Progress update\n進捗です。原因は再現できています",
          createdAt: "2026-03-17T01:10:00.000Z",
        },
      ],
      latestActionKind: "progress",
      latestActionAt: "2026-03-17T01:10:00.000Z",
    }));

    let followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-301",
        status: "awaiting-response",
      }),
    ]));

    piSessionMocks.runFollowupResolutionTurn.mockResolvedValueOnce({
      answered: true,
      answerKind: "status",
      confidence: 0.82,
      extractedFields: {
        status: "原因は再現できています",
        nextAction: "修正方針の整理",
        nextUpdate: "本日中",
      },
      reasoningSummary: "進捗と次アクションが示されているため、要求に答えています。",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-followup-resolve",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T01:10:00.000Z"),
    );

    expect(result.handled).toBe(true);
    followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-301",
        status: "resolved",
        resolvedReason: "answered",
        lastResponseKind: "followup-response",
        lastResponseText: "進捗です。原因は再現できています",
        resolutionAssessment: expect.objectContaining({
          answered: true,
          confidence: 0.82,
        }),
      }),
    ]));
    expect(followups.find((entry) => entry.issueId === "AIC-301")?.resolvedAt).toBeTruthy();
    const workgraphEvents = await createFileBackedManagerRepositories(systemPaths).workgraph.list();
    expect(workgraphEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "followup.resolved",
        issueId: "AIC-301",
        reason: "answered",
      }),
    ]));
  });

  it("keeps owner-missing follow-ups unresolved until an assignee is actually set", async () => {
    const repositories = createFileBackedManagerRepositories(systemPaths);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-305",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "owner_missing",
        status: "awaiting-response",
        requestText: "担当を決めて共有してください。",
      },
    ], null, 2)}\n`);
    await repositories.workgraph.append([
      {
        type: "planning.child_created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-owner-missing",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-owner-missing",
        sourceMessageTs: "msg-1",
        issueId: "AIC-305",
        title: "担当未設定の task",
        kind: "execution",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-owner-missing",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-owner-missing",
        sourceMessageTs: "msg-1",
        messageFingerprint: "owner-missing",
        childIssueIds: ["AIC-305"],
        planningReason: "single-issue",
        lastResolvedIssueId: "AIC-305",
      },
    ]);

    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-305",
      identifier: "AIC-305",
      title: "担当未設定の task",
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-owner-missing",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。確認を始めました",
      },
      new Date("2026-03-17T01:10:00.000Z"),
    );

    expect(result.handled).toBe(true);
    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-305",
        status: "awaiting-response",
        lastResponseKind: "progress",
      }),
    ]));
  });

  it("keeps a status follow-up unresolved when the reply lacks a next action", async () => {
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-306",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "stale",
        requestKind: "status",
        requestText: "現在の進捗と次アクション、次回更新予定を共有してください。",
        acceptableAnswerHint: "進捗 / 次アクション / 次回更新予定",
        status: "awaiting-response",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-status-followup",
        sourceMessageTs: "msg-1",
      },
    ], null, 2)}\n`);
    await createFileBackedManagerRepositories(systemPaths).workgraph.append([
      {
        type: "planning.child_created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-status-followup",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-status-followup",
        sourceMessageTs: "msg-1",
        issueId: "AIC-306",
        title: "進捗確認待ち task",
        kind: "execution",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-status-followup",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-status-followup",
        sourceMessageTs: "msg-1",
        messageFingerprint: "status-followup",
        childIssueIds: ["AIC-306"],
        planningReason: "single-issue",
        lastResolvedIssueId: "AIC-306",
      },
    ]);

    linearMocks.getLinearIssue.mockImplementationOnce(async () => ({
      id: "issue-306",
      identifier: "AIC-306",
      title: "進捗確認待ち task",
      relations: [],
      inverseRelations: [],
    })).mockImplementationOnce(async () => ({
      id: "issue-306",
      identifier: "AIC-306",
      title: "進捗確認待ち task",
      relations: [],
      inverseRelations: [],
      comments: [
        {
          id: "comment-1",
          body: "## Progress update\n進捗です。原因は再現できています",
          createdAt: "2026-03-17T01:20:00.000Z",
        },
      ],
      latestActionKind: "progress",
      latestActionAt: "2026-03-17T01:20:00.000Z",
    }));
    piSessionMocks.runFollowupResolutionTurn.mockResolvedValueOnce({
      answered: false,
      answerKind: "status",
      confidence: 0.42,
      extractedFields: {
        status: "原因は再現できています",
      },
      reasoningSummary: "進捗はあるが、次アクションと次回更新予定が不足しています。",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-status-followup",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T01:20:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("返答を受け取りました。");
    expect(result.reply).toContain("引き続きこの内容を教えてください。");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-306",
        status: "awaiting-response",
        lastResponseKind: "followup-response",
        lastResponseText: "進捗です。原因は再現できています",
        resolutionAssessment: expect.objectContaining({
          answered: false,
          confidence: 0.42,
        }),
      }),
    ]));
  });

  it("re-pings an unresolved follow-up after cooldown and increments the counter", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-302",
        title: "blocked のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);

    await createFileBackedManagerRepositories(systemPaths).workgraph.append([
      {
        type: "planning.child_created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-followup-reping",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-followup-reping",
        sourceMessageTs: "msg-1",
        issueId: "AIC-302",
        title: "blocked のタスク",
        kind: "execution",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-followup-reping",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-followup-reping",
        sourceMessageTs: "msg-1",
        messageFingerprint: "followup-reping",
        childIssueIds: ["AIC-302"],
        planningReason: "single-issue",
        lastResolvedIssueId: "AIC-302",
      },
    ]);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T01:00:00.000Z"),
    );

    const review = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "evening-review",
      new Date("2026-03-18T02:30:00.000Z"),
    );

    expect(review?.followup?.issueId).toBe("AIC-302");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-302",
        status: "awaiting-response",
        rePingCount: 1,
      }),
    ]));
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

  it("returns a heartbeat noop reason when urgent issues are suppressed by cooldown", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-400",
        title: "期限超過のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-400",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "overdue",
        status: "awaiting-response",
        requestText: "最新状況と次アクション、次回更新予定を共有してください。",
      },
    ], null, 2)}\n`);

    const decision = await buildHeartbeatReviewDecision(
      { ...config, workspaceDir },
      systemPaths,
      new Date("2026-03-17T01:00:00.000Z"),
    );

    expect(decision.review).toBeUndefined();
    expect(decision.reason).toBe("suppressed-by-cooldown");
  });

  it("marks awaiting follow-ups as resolved when the tracked risk disappears", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-401",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "overdue",
        status: "awaiting-response",
        requestText: "最新状況と次アクション、次回更新予定を共有してください。",
      },
    ], null, 2)}\n`);

    const review = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    expect(review?.text).toContain("今日すぐに共有が必要なリスクはありません。");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-401",
        status: "resolved",
        resolvedReason: "risk-cleared",
      }),
    ]));
  });

  it("marks due-missing follow-ups as resolved only when a due date is set", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-403",
        title: "期限未設定の task",
        dueDate: "2026-03-20",
        updatedAt: "2026-03-17T00:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-403",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "due_missing",
        status: "awaiting-response",
        requestText: "期限が必要なら共有してください。",
      },
    ], null, 2)}\n`);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-403",
        status: "resolved",
        resolvedReason: "risk-cleared",
      }),
    ]));
  });

  it("counts pending clarifications from the work graph in weekly review", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([]);
    await createFileBackedManagerRepositories(systemPaths).workgraph.append([
      {
        type: "intake.clarification_requested",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-weekly-clarify",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-weekly-clarify",
        sourceMessageTs: "msg-1",
        messageFingerprint: "weekly-clarify",
        clarificationQuestion: "期限を教えてください。",
        clarificationReasons: ["due_date"],
      },
      {
        type: "followup.requested",
        occurredAt: "2026-03-17T00:10:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-weekly-followup",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-weekly-followup",
        sourceMessageTs: "msg-2",
        issueId: "AIC-450",
        category: "stale",
        requestKind: "status",
      },
    ]);

    const review = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "weekly-review",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    expect(review?.text).toContain("未処理の clarification は 1 件です。");
    expect(review?.text).toContain("未回答の follow-up は 1 件です。");
    expect(review?.summaryLines).toContain("未処理の clarification は 1 件です。");
    expect(review?.summaryLines).toContain("未回答の follow-up は 1 件です。");
  });

  it("applies a due-date follow-up reply from the source thread and resolves it as risk-cleared", async () => {
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-404",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "due_missing",
        requestKind: "due-date",
        requestText: "期限を YYYY-MM-DD で共有してください。",
        acceptableAnswerHint: "YYYY-MM-DD",
        status: "awaiting-response",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-due-followup",
        sourceMessageTs: "msg-1",
      },
    ], null, 2)}\n`);
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-404",
      identifier: "AIC-404",
      title: "期限未設定の task",
      relations: [],
      inverseRelations: [],
    });
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-404",
      identifier: "AIC-404",
      title: "期限未設定の task",
      dueDate: "2026-03-20",
      relations: [],
      inverseRelations: [],
    });
    piSessionMocks.runFollowupResolutionTurn.mockResolvedValueOnce({
      answered: true,
      answerKind: "due-date",
      confidence: 0.92,
      extractedFields: {
        dueDate: "2026-03-20",
      },
      reasoningSummary: "期限が YYYY-MM-DD で指定されています。",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-due-followup",
        messageTs: "msg-2",
        userId: "U1",
        text: "期限は 2026-03-20 です",
      },
      new Date("2026-03-17T01:30:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("期限は 2026-03-20 として反映しました。");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-404",
        status: "resolved",
        resolvedReason: "risk-cleared",
      }),
    ]));
  });

  it("does not resolve a follow-up only because the issue remains risky with a different primary category", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-402",
        title: "期限超過かつ blocked の task",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Blocked", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-402",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "overdue",
        status: "awaiting-response",
        requestText: "最新状況と次アクション、次回更新予定を共有してください。",
      },
    ], null, 2)}\n`);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-18T02:00:00.000Z"),
    );

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-402",
        status: "awaiting-response",
      }),
    ]));
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

  it("commits agent issue creation proposals exactly once", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "この依頼は登録しておきます。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.93,
              summary: "新規 task の依頼です。",
            },
          },
        },
        {
          toolName: "propose_create_issue",
          details: {
            proposal: {
              commandType: "create_issue",
              planningReason: "single-issue",
              threadParentHandling: "ignore",
              duplicateHandling: "create-new",
              issue: {
                title: "OPT社の社内チャネルへの招待依頼",
                description: "## Slack source\n招待してもらう task を追加する",
                assigneeMode: "assign",
                assignee: "y.kakui",
              },
              reasonSummary: "単発 task と判断しました。",
              dedupeKeyCandidate: "thread-create-1",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "create-new",
          issue: {
            title: "OPT社の社内チャネルへの招待依頼",
            description: "## Slack source\n招待してもらう task を追加する",
            assigneeMode: "assign",
            assignee: "y.kakui",
          },
          reasonSummary: "単発 task と判断しました。",
          dedupeKeyCandidate: "thread-create-1",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.93,
        summary: "新規 task の依頼です。",
      },
    });

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-900",
      identifier: "AIC-900",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/issue/AIC-900",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Backlog", type: "unstarted" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agent-create",
        messageTs: "msg-agent-2",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-19T06:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain("AIC-900");
    expect(result.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "create_work",
      proposalCount: 1,
      committedCommands: ["create_issue"],
    });
  });

  it("attaches single issue create proposals to the existing thread parent", async () => {
    await recordPlanningOutcome(createFileBackedManagerRepositories(systemPaths).workgraph, {
      occurredAt: "2026-03-23T00:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agent-child-create",
        messageTs: "seed-parent-msg",
      },
      messageFingerprint: "seed parent thread",
      parentIssue: {
        issueId: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      parentIssueId: "AIC-39",
      childIssues: [],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-39",
      originalText: "親 issue の作成",
    });

    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "issue 化しておきます。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.95,
              summary: "既存親の子 issue 追加です。",
            },
          },
        },
        {
          toolName: "propose_create_issue",
          details: {
            proposal: {
              commandType: "create_issue",
              planningReason: "single-issue",
              threadParentHandling: "attach",
              duplicateHandling: "create-new",
              issue: {
                title: "コギトをシステム設定・プロンプトに命名として反映する",
                description: "## Slack source\nissue 化してください",
                assigneeMode: "leave-unassigned",
              },
              reasonSummary: "既存親の子 issue にする提案です。",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "attach",
          duplicateHandling: "create-new",
          issue: {
            title: "コギトをシステム設定・プロンプトに命名として反映する",
            description: "## Slack source\nissue 化してください",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "既存親の子 issue にする提案です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.95,
        summary: "既存親の子 issue 追加です。",
      },
    });

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-40",
      identifier: "AIC-40",
      title: "コギトをシステム設定・プロンプトに命名として反映する",
      url: "https://linear.app/kyaukyuai/issue/AIC-40",
      parent: {
        id: "parent-39",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agent-child-create",
        messageTs: "msg-agent-child-1",
        userId: "U1",
        text: "issue 化してください",
      },
      new Date("2026-03-23T00:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: "AIC-39",
        title: "コギトをシステム設定・プロンプトに命名として反映する",
      }),
      expect.any(Object),
    );
    expect(result.reply).toContain("親は AIC-39 AIマネージャーを実用レベルへ引き上げる");
    expect(result.reply).toContain("子 task として <https://linear.app/kyaukyuai/issue/AIC-40|AIC-40 コギトをシステム設定・プロンプトに命名として反映する> を追加しています。");
  });

  it("updates an existing issue parent directly when the user asks for a child-task relation", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-40",
      identifier: "AIC-40",
      title: "コギトをシステム設定・プロンプトに命名として反映する",
      url: "https://linear.app/kyaukyuai/issue/AIC-40",
      parent: {
        id: "parent-39",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      relations: [],
      inverseRelations: [],
    });

    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "AIC-40 を AIC-39 の子 task として反映します。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.94,
              summary: "既存 issue の親子付け替えです。",
            },
          },
        },
        {
          toolName: "propose_set_issue_parent",
          details: {
            proposal: {
              commandType: "set_issue_parent",
              issueId: "AIC-40",
              parentIssueId: "AIC-39",
              reasonSummary: "AIC-40 を AIC-39 の子 task にする依頼です。",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "set_issue_parent",
          issueId: "AIC-40",
          parentIssueId: "AIC-39",
          reasonSummary: "AIC-40 を AIC-39 の子 task にする依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.94,
        summary: "既存 issue の親子付け替えです。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parent-update",
        messageTs: "msg-parent-update-1",
        userId: "U1",
        text: "AIC-40 を AIC-39 の子タスクとしてください",
      },
      new Date("2026-03-23T01:30:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-40",
        parent: "AIC-39",
      }),
      expect.any(Object),
    );
    expect(result.reply).toContain("AIC-40 を AIC-39 の子 task");
    expect(result.reply).toContain("> system log: AIC-40 を AIC-39 の子 task として反映しました。");

    const thread = await loadThreadProjection("C0ALAMDRB9V:thread-parent-update");
    expect(thread).toMatchObject({
      parentIssueId: "AIC-39",
      childIssueIds: expect.arrayContaining(["AIC-40"]),
      lastResolvedIssueId: "AIC-40",
    });
  });

  it("keeps a quoted linked system log for Notion agenda creation when the agent reply has no link", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "「2026.03.26 | AIクローンプラットフォーム Vol.1」のアジェンダを Notion に作成します。目的・議題・確認事項・次のアクションの構成にしました。",
      toolCalls: [],
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
          summary: "進捗共有と進め方のすりあわせです。",
          reasonSummary: "Notion に会議用アジェンダを作る依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.95,
        summary: "Notion に会議用アジェンダを作る依頼です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-agenda",
        messageTs: "msg-notion-agenda-1",
        userId: "U1",
        text: "Notion にアジェンダを作って",
      },
      new Date("2026-03-24T00:22:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("アジェンダを Notion に作成します。");
    expect(result.reply).toContain("> system log: Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(notionMocks.createNotionAgendaPage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
        parentPageId: "parent-page-1",
      }),
      expect.any(Object),
    );
  });

  it("keeps a quoted linked system log for Notion page updates when the agent reply has no link", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "その Notion ページに補足を追記しました。",
      toolCalls: [],
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-1",
          summary: "プロジェクトの進め方を追記しました。",
          appendMode: "append",
          reasonSummary: "直前の Notion ページを更新する依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.9,
        summary: "Notion ページ更新の依頼です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-update",
        messageTs: "msg-notion-update-1",
        userId: "U1",
        text: "そのページに追記して",
      },
      new Date("2026-03-24T00:24:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Notion ページに補足を追記しました。");
    expect(result.reply).toContain("> system log: Notion page updated: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-1",
        summary: "プロジェクトの進め方を追記しました。",
      }),
      expect.any(Object),
    );
  });

  it("keeps a quoted linked system log for Notion page archive when the agent reply has no link", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "その Notion ページをアーカイブしました。",
      toolCalls: [],
      proposals: [
        {
          commandType: "archive_notion_page",
          pageId: "notion-page-1",
          reasonSummary: "不要になった Notion ページを削除する依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.9,
        summary: "Notion ページ archive の依頼です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-archive",
        messageTs: "msg-notion-archive-1",
        userId: "U1",
        text: "そのページを削除して",
      },
      new Date("2026-03-24T00:25:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Notion ページをアーカイブしました。");
    expect(result.reply).toContain("> system log: Notion page archived: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(notionMocks.archiveNotionPage).toHaveBeenCalledWith(
      "notion-page-1",
      expect.any(Object),
    );
  });

  it("keeps a quoted system log with a link when a custom scheduler job is run immediately", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "weekly-notion-agenda-ai-clone を今すぐ実行しました。結果を確認してください。",
      toolCalls: [],
      proposals: [
        {
          commandType: "run_scheduler_job_now",
          jobId: "weekly-notion-agenda-ai-clone",
          reasonSummary: "動作確認のため 1 回だけ実行します。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "run_schedule",
        confidence: 0.96,
        summary: "custom scheduler job の即時実行です。",
      },
    });

    const systemPaths = buildSystemPaths(workspaceDir);
    await writeFile(systemPaths.jobsFile, `${JSON.stringify([
      {
        id: "weekly-notion-agenda-ai-clone",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "Notion に AIクローンプラットフォームのアジェンダを作成する",
        kind: "weekly",
        weekday: "thu",
        time: "09:00",
        nextRunAt: "2026-03-26T00:00:00.000Z",
      },
    ], null, 2)}\n`, "utf8");

    const runSchedulerJobNow = vi.fn().mockResolvedValue({
      status: "ok",
      persistedSummary: "Notion にアジェンダを作成しました。",
      commitSummary: "Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>",
      executedAt: "2026-03-24T01:05:00.000Z",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-run-now",
        messageTs: "msg-scheduler-run-now-1",
        userId: "U1",
        text: "weekly-notion-agenda-ai-clone を今すぐ実行して",
      },
      new Date("2026-03-24T01:05:00.000Z"),
      undefined,
      { runSchedulerJobNow },
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("weekly-notion-agenda-ai-clone を今すぐ実行しました。");
    expect(result.reply).toContain("> system log: Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(runSchedulerJobNow).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "weekly-notion-agenda-ai-clone",
      }),
    );
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
      loadPendingManagerClarification(buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-run-task-clarify")),
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
      loadPendingManagerClarification(buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-run-task-misclassified")),
    ).resolves.toMatchObject({
      intent: "run_task",
      lastUserMessage: "AIC-52 を実行して",
      missingDecisionSummary: "manager agent explicit run_task misclassified as query",
    });
  });
});
