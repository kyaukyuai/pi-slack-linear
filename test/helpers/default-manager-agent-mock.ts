import type { AppConfig } from "../../src/lib/config.js";
import {
  classifyManagerSignal,
  fingerprintText,
  formatIssueSelectionReply,
  type ManagerHandleResult,
  type ManagerSlackMessage,
  type ManagerQueryKind,
} from "../../src/lib/manager.js";
import type { ManagerAgentInput, ManagerAgentTurnResult } from "../../src/lib/pi-session.js";
import {
  combinePendingManagerClarificationRequest,
  isPendingManagerClarificationContinuation,
  isPendingManagerClarificationStatusQuestion,
} from "../../src/lib/pending-manager-clarification.js";
import {
  buildRunTaskClarifyReply,
  buildRunTaskNoopReply,
  isRunTaskRequestText,
} from "../../src/orchestrators/execution/handle-run-task.js";
import type { SystemPaths } from "../../src/lib/system-workspace.js";
import { handleIntakeRequest } from "../../src/orchestrators/intake/handle-intake.js";
import {
  handleManagerUpdates,
  type ManagerSignal,
} from "../../src/orchestrators/updates/handle-updates.js";
import { createFileBackedManagerRepositories } from "../../src/state/repositories/file-backed-manager-repositories.js";
import { buildWorkgraphThreadKey } from "../../src/state/workgraph/events.js";
import {
  getPendingClarificationForThread,
  getThreadPlanningContext,
  type WorkgraphIssueContext,
} from "../../src/state/workgraph/queries.js";
import { summarizeSlackReply, type ThreadQueryContinuation } from "../../src/lib/query-continuation.js";
import { assessRisk } from "../../src/orchestrators/review/risk.js";
import { formatReviewFollowupPrompt } from "../../src/orchestrators/review/review-helpers.js";

type RouterResult = {
  action: "conversation" | "query" | "run_task" | "create_work" | "update_progress" | "update_completed" | "update_blocked";
  conversationKind?: "greeting" | "smalltalk" | "other";
  queryKind?: ManagerQueryKind;
  queryScope?: "self" | "team" | "thread-context";
  confidence?: number;
  reasoningSummary?: string;
};

type ReplyBuilder = (input: {
  kind: string;
  conversationKind?: string;
  facts?: Record<string, unknown>;
}) => { reply: string };

type LinearIssueFact = Record<string, unknown> & {
  identifier: string;
  title: string;
  assignee?: { displayName?: string | null; name?: string | null; email?: string | null } | null;
  dueDate?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  state?: { name?: string | null } | null;
  updatedAt?: string | null;
};

interface DefaultManagerAgentMockArgs {
  config: AppConfig;
  systemPaths: SystemPaths;
  linearMocks: {
    listOpenLinearIssues: (...args: unknown[]) => Promise<LinearIssueFact[]>;
    searchLinearIssues: (...args: unknown[]) => Promise<LinearIssueFact[]>;
    getLinearIssue: (...args: unknown[]) => Promise<LinearIssueFact>;
  };
  slackContextMocks: {
    getSlackThreadContext: (...args: unknown[]) => Promise<{ entries?: Array<{ text?: string }> }>;
  };
  route: (input: {
    messageText: string;
    threadContext?: {
      pendingClarification?: boolean;
      intakeStatus?: string;
      parentIssueId?: string;
      childIssueIds?: string[];
      latestFocusIssueId?: string;
      lastResolvedIssueId?: string;
    };
    lastQueryContext?: ThreadQueryContinuation;
  }) => RouterResult;
  buildReply: ReplyBuilder;
}

function normalize(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function toJstDate(date: Date): Date {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function isContinuationQuery(text: string): boolean {
  return /(?:他には|ほかには|他の|ほかの|残り|続き|さらに)/.test(text);
}

function isReferenceMaterialContinuation(text: string, lastQueryContext?: ThreadQueryContinuation): boolean {
  if (lastQueryContext?.kind !== "reference-material") {
    return false;
  }
  return /(?:詳しく|詳細|項目|内容|範囲|確認|見て|読んで|教えて)/.test(text);
}

function isNotionDatabaseRequest(text: string): boolean {
  return /(?:notion|ノーション).*(?:database|データベース)|(?:database|データベース).*(?:notion|ノーション)/i.test(text);
}

function extractQuotedSearchKeyword(text: string): string | undefined {
  const match = text.match(/[「"']([^」"']+)[」"']/);
  return match?.[1]?.trim();
}

function getIssueAssigneeLabel(issue: LinearIssueFact): string | undefined {
  return issue.assignee?.displayName ?? issue.assignee?.name ?? issue.assignee?.email ?? undefined;
}

function matchesAssignee(issue: LinearIssueFact, assignee: string): boolean {
  const normalizedAssignee = normalize(assignee);
  return normalize(issue.assignee?.displayName) === normalizedAssignee
    || normalize(issue.assignee?.name) === normalizedAssignee
    || normalize(issue.assignee?.email) === normalizedAssignee;
}

function dueSortValue(dueDate: string | null | undefined): number {
  if (!dueDate) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(`${dueDate}T00:00:00Z`);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function updateSortValue(updatedAt: string | null | undefined): number {
  if (!updatedAt) return 0;
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function prioritySortValue(priority: number | null | undefined): number {
  return typeof priority === "number" ? priority : Number.POSITIVE_INFINITY;
}

function sortIssues(issues: LinearIssueFact[]): LinearIssueFact[] {
  return [...issues].sort((left, right) => (
    dueSortValue(left.dueDate) - dueSortValue(right.dueDate)
    || prioritySortValue(left.priority) - prioritySortValue(right.priority)
    || updateSortValue(right.updatedAt) - updateSortValue(left.updatedAt)
    || left.identifier.localeCompare(right.identifier)
  ));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isTodayRelevant(issue: LinearIssueFact, now: Date): boolean {
  if (typeof issue.priority === "number" && issue.priority <= 2) {
    return true;
  }
  if (!issue.dueDate) {
    return false;
  }
  const due = Date.parse(`${issue.dueDate}T00:00:00Z`);
  if (Number.isNaN(due)) {
    return false;
  }
  const jstNow = toJstDate(now);
  const today = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate());
  const tomorrow = addDays(new Date(today), 1).getTime();
  return due <= tomorrow;
}

function buildIssueSelectionCandidates(issues: WorkgraphIssueContext[]) {
  return issues.map((issue) => ({
    issueId: issue.issueId,
    title: issue.title,
    latestActionLabel: issue.lastStatus,
    focusReason: issue.issueId === issues[0]?.issueId ? "thread context" : undefined,
  }));
}

function chooseIssueFromRecentContext(
  issues: WorkgraphIssueContext[],
  recentEntries: Array<{ text?: string }> | undefined,
): WorkgraphIssueContext | undefined {
  const combined = normalize((recentEntries ?? []).map((entry) => entry.text ?? "").join("\n"));
  if (!combined) return undefined;
  return issues.find((issue) => normalize(issue.title).length >= 2 && combined.includes(normalize(issue.title)));
}

function chooseIssueFromText(
  issues: WorkgraphIssueContext[],
  text: string,
): WorkgraphIssueContext | undefined {
  const normalizedText = normalize(text);
  return issues.find((issue) => normalize(issue.title).length >= 2 && normalizedText.includes(normalize(issue.title)));
}

function isBareStatusUpdate(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 24
    || /^(?:進捗です|終わりました|完了です|completed|blocked(?: です)?)(?:[。!！?？]|$)/i.test(normalized);
}

function buildIntentToolCall(intentReport: Record<string, unknown>) {
  return {
    toolName: "report_manager_intent",
    details: { intentReport },
  };
}

function buildQuerySnapshotToolCall(snapshot: Record<string, unknown>) {
  return {
    toolName: "report_query_snapshot",
    details: { querySnapshot: snapshot },
  };
}

function buildPendingClarificationDecisionToolCall(
  decision: string,
  persistence: "keep" | "replace" | "clear",
  summary: string,
) {
  return {
    toolName: "report_pending_clarification_decision",
    details: {
      pendingClarificationDecision: {
        decision,
        persistence,
        summary,
      },
    },
  };
}

function buildTaskExecutionDecisionToolCall(
  decision: "execute" | "noop",
  targetIssueId: string | undefined,
  targetIssueIdentifier: string | undefined,
  summary: string,
) {
  return {
    toolName: "report_task_execution_decision",
    details: {
      taskExecutionDecision: {
        decision,
        targetIssueId,
        targetIssueIdentifier,
        summary,
      },
    },
  };
}

async function buildQueryTurn(
  args: DefaultManagerAgentMockArgs,
  input: ManagerAgentInput,
  router: RouterResult,
): Promise<ManagerAgentTurnResult> {
  const repositories = createFileBackedManagerRepositories(args.systemPaths);
  const ownerMap = await repositories.ownerMap.load();
  const threadKey = buildWorkgraphThreadKey(input.channelId, input.rootThreadTs);
  const planningContext = await getThreadPlanningContext(repositories.workgraph, threadKey).catch(() => undefined);
  const activeIssues = sortIssues(await args.linearMocks.listOpenLinearIssues());

  const mappedOwner = ownerMap.entries.find((entry) => entry.slackUserId === input.userId);
  const ownerScopedIssues = mappedOwner?.linearAssignee
    ? activeIssues.filter((issue) => matchesAssignee(issue, mappedOwner.linearAssignee!))
    : [];
  const shouldPreferMappedOwner = Boolean(
    mappedOwner?.linearAssignee
    && ownerScopedIssues.length > 0
    && (router.queryScope === "self" || router.queryKind === "list-today" || router.queryKind === "what-should-i-do"),
  );
  const viewerDisplayLabel = shouldPreferMappedOwner
    ? `${mappedOwner.linearAssignee} さんの担当`
    : undefined;
  const viewerMappingMissing = router.queryScope === "self" && !mappedOwner?.linearAssignee;
  const scopedIssues = router.queryScope === "self" && mappedOwner?.linearAssignee
      ? ownerScopedIssues
      : activeIssues;

  const continuationRemaining = input.lastQueryContext?.remainingIssueIds ?? [];
  const continuationShown = input.lastQueryContext?.shownIssueIds ?? [];

  const buildSnapshot = (selectedIssueIds: string[], relevantIssueIds: string[]) => {
    const shownIssueIds = unique([
      ...(router.queryScope === "thread-context" ? continuationShown : []),
      ...selectedIssueIds,
    ]);
    const remainingIssueIds = relevantIssueIds.filter((issueId) => !shownIssueIds.includes(issueId));
    return {
      issueIds: selectedIssueIds,
      shownIssueIds,
      remainingIssueIds,
      totalItemCount: relevantIssueIds.length,
    };
  };

  if (router.queryKind === "reference-material") {
    const databaseReferenceItems = input.lastQueryContext?.referenceItems?.filter((item) => item.source === "notion-database") ?? [];
    const databaseOnly = isNotionDatabaseRequest(input.text)
      || (databaseReferenceItems.length > 0 && /(?:その|この).*(?:database|データベース)|一覧を(?:見て|確認)/i.test(input.text));
    const keyword = extractQuotedSearchKeyword(input.text);
    const referenceItems = databaseOnly
      ? (databaseReferenceItems.length > 0
        ? databaseReferenceItems
        : [{
            id: "notion-database-1",
            title: "案件一覧",
            url: "https://www.notion.so/notion-database-1",
            source: "notion-database",
          }])
      : input.lastQueryContext?.referenceItems ?? [{
          id: "notion-page-1",
          title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
          url: "https://www.notion.so/notion-page-1",
          source: "notion",
        }];
    const reply = databaseOnly
      ? databaseReferenceItems.length > 0 && /(?:その|この).*(?:database|データベース)|一覧を(?:見て|確認)/i.test(input.text)
        ? `${referenceItems[0]?.title ?? "Notion database"} を確認しました。冒頭 2 件は Alpha 社 / Beta 社で、どちらも進行中です。`
        : keyword
          ? `「${keyword}」に一致する Notion database は 1 件です。\n- [${referenceItems[0]?.title ?? "案件一覧"}](${referenceItems[0]?.url ?? "https://www.notion.so/notion-database-1"})`
          : [
              "アクセスできる Notion database は次のとおりです。",
              ...referenceItems.map((item) => `- [${item.title ?? item.id}](${item.url ?? "https://www.notion.so/notion-database-1"})`),
            ].join("\n")
      : args.buildReply({
          kind: "reference-material",
          facts: {
            source: /notion|ノーション/i.test(input.text) ? "notion" : "reference",
            referenceItems,
            followupTopic: input.text,
          },
        }).reply;
    return {
      reply,
      toolCalls: [
        buildIntentToolCall({
          intent: "query",
          queryKind: "reference-material",
          queryScope: router.queryScope,
          confidence: router.confidence,
          summary: router.reasoningSummary,
        }),
        buildQuerySnapshotToolCall({
          issueIds: [],
          shownIssueIds: [],
          remainingIssueIds: [],
          totalItemCount: 0,
          replySummary: summarizeSlackReply(reply),
          scope: router.queryScope,
          referenceItems,
        }),
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "reference-material",
        queryScope: router.queryScope,
        confidence: router.confidence,
        summary: router.reasoningSummary,
      },
    };
  }

  if (router.queryKind === "search-existing") {
    const query = (() => {
      const explicit = input.text.replace(/(?:既存|issue|タスク|ある|あったっけ|探して|検索して|\?|？)/g, "").trim();
      if (explicit) return explicit;
      return planningContext?.latestResolvedIssue?.title
        ?? planningContext?.parentIssue?.title
        ?? planningContext?.thread.originalText
        ?? input.text;
    })();
    const issues = await args.linearMocks.searchLinearIssues(
      { query, limit: 5 },
      {
        ...process.env,
        LINEAR_API_KEY: args.config.linearApiKey,
        LINEAR_WORKSPACE: args.config.linearWorkspace,
        LINEAR_TEAM_KEY: args.config.linearTeamKey,
      },
    );
    const reply = args.buildReply({ kind: "search-existing", facts: { issues } }).reply;
    return {
      reply,
      toolCalls: [
        buildIntentToolCall({
          intent: "query",
          queryKind: "search-existing",
          queryScope: router.queryScope,
          confidence: router.confidence,
          summary: router.reasoningSummary,
        }),
        buildQuerySnapshotToolCall({
          issueIds: issues.map((issue) => issue.identifier),
          shownIssueIds: issues.map((issue) => issue.identifier),
          remainingIssueIds: [],
          totalItemCount: issues.length,
          replySummary: summarizeSlackReply(reply),
          scope: router.queryScope,
        }),
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: "search-existing",
        queryScope: router.queryScope,
        confidence: router.confidence,
        summary: router.reasoningSummary,
      },
    };
  }

  if (router.queryKind === "inspect-work" || router.queryKind === "recommend-next-step") {
    const explicitIssueId = (input.text.match(/\b[A-Z][A-Z0-9]+-\d+\b/) ?? [])[0];
    const candidateIssues = unique([
      planningContext?.latestResolvedIssue?.issueId,
      planningContext?.thread.latestFocusIssueId,
      planningContext?.thread.lastResolvedIssueId,
      planningContext?.thread.parentIssueId,
      ...(planningContext?.thread.childIssueIds ?? []),
      ...(planningContext?.thread.linkedIssueIds ?? []),
    ])
      .map((issueId) => issueId ? [
        planningContext?.latestResolvedIssue,
        planningContext?.parentIssue,
        ...(planningContext?.childIssues ?? []),
        ...(planningContext?.linkedIssues ?? []),
      ].flat().find((issue) => issue?.issueId === issueId) : undefined)
      .filter((issue): issue is WorkgraphIssueContext => Boolean(issue));
    const recentThreadContext = await args.slackContextMocks.getSlackThreadContext(
      input.channelId,
      input.rootThreadTs,
      8,
    ).catch(() => ({ entries: [] }));
    const selectedIssueId = explicitIssueId
      ?? chooseIssueFromText(candidateIssues, input.text)?.issueId
      ?? chooseIssueFromRecentContext(candidateIssues, recentThreadContext.entries)?.issueId
      ?? planningContext?.thread.latestFocusIssueId
      ?? planningContext?.thread.lastResolvedIssueId
      ?? candidateIssues[0]?.issueId;

    if (!selectedIssueId) {
      const reply = "どの issue を見ればよいかまだ特定できていません。issue ID を添えてもう一度送ってください。";
      return {
        reply,
        toolCalls: [buildIntentToolCall({
          intent: "query",
          queryKind: router.queryKind,
          queryScope: router.queryScope,
          confidence: router.confidence,
          summary: router.reasoningSummary,
        })],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: "query",
          queryKind: router.queryKind,
          queryScope: router.queryScope,
          confidence: router.confidence,
          summary: router.reasoningSummary,
        },
      };
    }

    const issue = await args.linearMocks.getLinearIssue(selectedIssueId, undefined, undefined, { includeComments: true });
    const issueFacts = {
      ...issue,
      state: issue.state?.name ?? undefined,
      dueDate: issue.dueDate ?? undefined,
      priorityLabel: issue.priorityLabel ?? undefined,
    };
    const recentThreadSummary = (recentThreadContext.entries ?? [])
      .map((entry) => entry.text ?? "")
      .filter(Boolean)
      .slice(-2)
      .join(" ");
    const recommendedAction = router.queryKind === "recommend-next-step"
      ? recentThreadSummary.includes("下書き")
        ? "次は今の進捗を 1 行で返すか、そのまま依頼済みなら完了に更新してください。"
        : "次は今の進捗を 1 行で返すか、止まっている理由があれば blocked と共有してください。"
      : undefined;
    const reply = args.buildReply({
      kind: router.queryKind,
      facts: {
        issue: issueFacts,
        recentThreadSummary,
        recommendedAction,
      },
    }).reply;
    return {
      reply,
      toolCalls: [
        buildIntentToolCall({
          intent: "query",
          queryKind: router.queryKind,
          queryScope: router.queryScope,
          confidence: router.confidence,
          summary: router.reasoningSummary,
        }),
        buildQuerySnapshotToolCall({
          issueIds: [issue.identifier],
          shownIssueIds: [issue.identifier],
          remainingIssueIds: [],
          totalItemCount: 1,
          replySummary: summarizeSlackReply(reply),
          scope: router.queryScope,
        }),
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: "query",
        queryKind: router.queryKind,
        queryScope: router.queryScope,
        confidence: router.confidence,
        summary: router.reasoningSummary,
      },
    };
  }

  const relevantIssues = (() => {
    if (
      router.queryScope === "thread-context"
      && continuationRemaining.length > 0
      && (router.queryKind === "list-active" || router.queryKind === "list-today" || router.queryKind === "what-should-i-do")
    ) {
      return activeIssues.filter((issue) => continuationRemaining.includes(issue.identifier));
    }
    if (router.queryKind === "list-today" || router.queryKind === "what-should-i-do") {
      const todayRelevant = scopedIssues.filter((issue) => isTodayRelevant(issue, new Date(`${input.currentDate}T00:00:00.000Z`)));
      return todayRelevant.length > 0 ? todayRelevant : scopedIssues;
    }
    return scopedIssues;
  })();

  const preferredRelevantIssues = shouldPreferMappedOwner
    ? relevantIssues.filter((issue) => matchesAssignee(issue, mappedOwner!.linearAssignee!))
    : relevantIssues;
  const limitedItems = relevantIssues.slice(0, router.queryKind === "what-should-i-do" ? 3 : 5);
  const selectedItems = router.queryKind === "what-should-i-do"
    ? (preferredRelevantIssues[0] ? [preferredRelevantIssues[0]] : limitedItems.slice(0, 1))
    : shouldPreferMappedOwner && router.queryKind === "list-today"
      ? (preferredRelevantIssues.length > 0 ? preferredRelevantIssues.slice(0, 5) : limitedItems)
      : limitedItems;
  const reply = args.buildReply({
    kind: router.queryKind,
    facts: {
      selectedItems,
      viewerDisplayLabel,
      viewerMappingMissing,
    },
  }).reply;
  const snapshot = buildSnapshot(
    selectedItems.map((issue) => issue.identifier),
    relevantIssues.map((issue) => issue.identifier),
  );
  return {
    reply,
    toolCalls: [
      buildIntentToolCall({
        intent: "query",
        queryKind: router.queryKind,
        queryScope: router.queryScope,
        confidence: router.confidence,
        summary: router.reasoningSummary,
      }),
      buildQuerySnapshotToolCall({
        ...snapshot,
        replySummary: summarizeSlackReply(reply),
        scope: router.queryScope,
      }),
    ],
    proposals: [],
    invalidProposalCount: 0,
    intentReport: {
      intent: "query",
      queryKind: router.queryKind,
      queryScope: router.queryScope,
      confidence: router.confidence,
      summary: router.reasoningSummary,
    },
  };
}

export function createDefaultTestManagerAgentTurn(args: DefaultManagerAgentMockArgs) {
  return async (_config: AppConfig, _paths: unknown, input: ManagerAgentInput): Promise<ManagerAgentTurnResult> => {
    const repositories = createFileBackedManagerRepositories(args.systemPaths);
    const policy = await repositories.policy.load();
    const followups = await repositories.followups.load();
    const turnNow = new Date(`${input.currentDate}T00:00:00.000Z`);
    const pendingClarification = input.pendingClarification;
    const workgraphPendingClarification = await getPendingClarificationForThread(
      repositories.workgraph,
      buildWorkgraphThreadKey(input.channelId, input.rootThreadTs),
    ).catch(() => undefined);
    const pendingDecision = pendingClarification
      ? isPendingManagerClarificationStatusQuestion(input.text)
        ? {
            decision: "status_question" as const,
            persistence: "keep" as const,
            summary: "前の補足依頼の状況確認です。",
          }
        : isPendingManagerClarificationContinuation(input.text)
          ? {
              decision: "continue_pending" as const,
              persistence: "keep" as const,
              summary: "前の補足依頼への返答です。",
            }
          : {
              decision: "new_request" as const,
              persistence: "clear" as const,
              summary: "pending clarification はありますが今回の発話は別件です。",
            }
      : undefined;
    const effectiveText = pendingDecision?.decision === "continue_pending" && pendingClarification
      ? combinePendingManagerClarificationRequest(pendingClarification, input.text)
      : input.text;
    const planningContext = await getThreadPlanningContext(
      repositories.workgraph,
      buildWorkgraphThreadKey(input.channelId, input.rootThreadTs),
    ).catch(() => undefined);

    let router = args.route({
      messageText: effectiveText,
      threadContext: {
        pendingClarification: Boolean(pendingClarification),
        intakeStatus: planningContext?.thread.intakeStatus,
        parentIssueId: planningContext?.thread.parentIssueId,
        childIssueIds: planningContext?.thread.childIssueIds ?? [],
        latestFocusIssueId: planningContext?.thread.latestFocusIssueId,
        lastResolvedIssueId: planningContext?.thread.lastResolvedIssueId,
      },
      lastQueryContext: input.lastQueryContext,
    });

    const hasAwaitingFollowupOnThread = followups.some((entry) => (
      entry.status === "awaiting-response"
      && entry.sourceChannelId === input.channelId
      && entry.sourceThreadTs === input.rootThreadTs
    ));

    if ((!router.queryKind || router.action === "conversation") && input.lastQueryContext && isContinuationQuery(input.text)) {
      router = {
        action: "query",
        queryKind: input.lastQueryContext.kind === "what-should-i-do" ? "list-active" : input.lastQueryContext.kind,
        queryScope: "thread-context",
        confidence: 0.9,
        reasoningSummary: "直前の query continuation です。",
      };
    }
    if ((!router.queryKind || router.action === "conversation") && isReferenceMaterialContinuation(input.text, input.lastQueryContext)) {
      router = {
        action: "query",
        queryKind: "reference-material",
        queryScope: "thread-context",
        confidence: 0.9,
        reasoningSummary: "直前の reference-material query の続きです。",
      };
    }
    if ((router.action === "conversation" || router.action === "create_work") && isRunTaskRequestText(input.text)) {
      router = {
        action: "run_task",
        confidence: 0.9,
        reasoningSummary: "既存 issue の実行依頼です。",
      };
    }
    if (router.action === "query" && !router.queryScope) {
      router = {
        ...router,
        queryScope: input.lastQueryContext?.scope ?? "team",
      };
    }

    if (router.action === "conversation" && !hasAwaitingFollowupOnThread) {
      const reply = args.buildReply({
        kind: "conversation",
        conversationKind: router.conversationKind,
      }).reply;
      return {
        reply,
        toolCalls: [
          ...(pendingDecision ? [buildPendingClarificationDecisionToolCall(pendingDecision.decision, pendingDecision.persistence, pendingDecision.summary)] : []),
          buildIntentToolCall({
            intent: "conversation",
            confidence: router.confidence,
            summary: router.reasoningSummary,
          }),
        ],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: "conversation",
          confidence: router.confidence,
          summary: router.reasoningSummary,
        },
        pendingClarificationDecision: pendingDecision,
      };
    }

    if (router.action === "query" && router.queryKind) {
      const result = await buildQueryTurn(args, {
        ...input,
        text: effectiveText,
      }, router);
      return {
        ...result,
        toolCalls: [
          ...(pendingDecision ? [buildPendingClarificationDecisionToolCall(pendingDecision.decision, pendingDecision.persistence, pendingDecision.summary)] : []),
          ...result.toolCalls,
        ],
        pendingClarificationDecision: pendingDecision,
      };
    }

    if (router.action === "run_task") {
      const explicitIssueId = (effectiveText.match(/\b[A-Z][A-Z0-9]+-\d+\b/) ?? [])[0];
      const targetIssueId = explicitIssueId
        ?? planningContext?.thread.latestFocusIssueId
        ?? planningContext?.thread.lastResolvedIssueId
        ?? planningContext?.thread.parentIssueId
        ?? planningContext?.thread.childIssueIds[0]
        ?? planningContext?.thread.linkedIssueIds[0];

      if (!targetIssueId) {
        const runTaskPendingDecision = pendingDecision ?? {
          decision: "new_request" as const,
          persistence: "replace" as const,
          summary: "run_task の対象 issue を確認するため、issue ID の補足待ちです。",
        };
        const reply = buildRunTaskClarifyReply();
        return {
          reply,
          toolCalls: [
            buildPendingClarificationDecisionToolCall(
              runTaskPendingDecision.decision,
              runTaskPendingDecision.persistence,
              runTaskPendingDecision.summary,
            ),
            buildIntentToolCall({
              intent: "run_task",
              confidence: router.confidence,
              summary: router.reasoningSummary,
            }),
            buildTaskExecutionDecisionToolCall("noop", undefined, undefined, "実行対象の issue を特定できませんでした。"),
          ],
          proposals: [],
          invalidProposalCount: 0,
          intentReport: {
            intent: "run_task",
            confidence: router.confidence,
            summary: router.reasoningSummary,
          },
          pendingClarificationDecision: runTaskPendingDecision,
          taskExecutionDecision: {
            decision: "noop",
            summary: "実行対象の issue を特定できませんでした。",
          },
        };
      }

      const issue = await args.linearMocks.getLinearIssue(targetIssueId, undefined, undefined, { includeComments: true });
      const issueStateName = normalize(
        typeof issue.state === "string"
          ? issue.state
          : issue.state && typeof issue.state === "object" && "name" in issue.state
            ? String(issue.state.name ?? "")
            : "",
      );
      if (issueStateName === "done" || issueStateName === "completed" || issueStateName === "canceled") {
        const reply = buildRunTaskNoopReply(issue.identifier, "対象 issue はすでに完了状態です");
        return {
          reply,
          toolCalls: [
            ...(pendingDecision ? [buildPendingClarificationDecisionToolCall(pendingDecision.decision, pendingDecision.persistence, pendingDecision.summary)] : []),
            buildIntentToolCall({
              intent: "run_task",
              confidence: router.confidence,
              summary: router.reasoningSummary,
            }),
            buildTaskExecutionDecisionToolCall("noop", issue.id, issue.identifier, "対象 issue はすでに完了状態です。"),
          ],
          proposals: [],
          invalidProposalCount: 0,
          intentReport: {
            intent: "run_task",
            confidence: router.confidence,
            summary: router.reasoningSummary,
          },
          pendingClarificationDecision: pendingDecision,
          taskExecutionDecision: {
            decision: "noop",
            targetIssueId: issue.id,
            targetIssueIdentifier: issue.identifier,
            summary: "対象 issue はすでに完了状態です。",
          },
        };
      }

      const reply = `${issue.identifier} はまだ実行の起点が無かったため、まず進め方コメントを追加しました。必要ならこの thread で続きの進捗を共有してください。`;
      return {
        reply,
        toolCalls: [
          ...(pendingDecision ? [buildPendingClarificationDecisionToolCall(pendingDecision.decision, pendingDecision.persistence, pendingDecision.summary)] : []),
          buildIntentToolCall({
            intent: "run_task",
            confidence: router.confidence,
            summary: router.reasoningSummary,
          }),
          buildTaskExecutionDecisionToolCall(
            "execute",
            issue.id,
            issue.identifier,
            "進め方コメントを既存 proposal surface で追加できます。",
          ),
        ],
        proposals: [{
          commandType: "add_comment",
          issueId: issue.identifier,
          body: "## AI execution\nSlack からの実行依頼を受けて確認を開始しました。",
          reasonSummary: `${issue.identifier} の実行起点を残します。`,
          evidenceSummary: "Slack から task execution の依頼がありました。",
          dedupeKeyCandidate: `run-task:${issue.identifier}:${normalize(input.text)}`,
        }],
        invalidProposalCount: 0,
        intentReport: {
          intent: "run_task",
          confidence: router.confidence,
          summary: router.reasoningSummary,
        },
        pendingClarificationDecision: pendingDecision,
        taskExecutionDecision: {
          decision: "execute",
          targetIssueId: issue.id,
          targetIssueIdentifier: issue.identifier,
          summary: "進め方コメントを既存 proposal surface で追加できます。",
        },
      };
    }

    if (router.action === "create_work") {
      const message: ManagerSlackMessage = {
        channelId: input.channelId,
        rootThreadTs: input.rootThreadTs,
        messageTs: input.messageTs,
        userId: input.userId,
        text: effectiveText,
      };
      const originalRequestText = pendingDecision?.decision === "continue_pending" && pendingClarification
        ? pendingClarification.originalUserMessage
        : input.text;
      const requestMessage: ManagerSlackMessage = pendingClarification
        ? {
            ...message,
            text: effectiveText,
          }
        : message;
      const result = await handleIntakeRequest({
        config: args.config,
        repositories,
        message,
        now: turnNow,
        policy,
        pendingClarification: workgraphPendingClarification,
        originalRequestText,
        requestMessage,
        env: {
          ...process.env,
          LINEAR_API_KEY: args.config.linearApiKey,
          LINEAR_WORKSPACE: args.config.linearWorkspace,
          LINEAR_TEAM_KEY: args.config.linearTeamKey,
        },
        helpers: {
          toJstDate,
          fingerprintText,
          nowIso,
        },
      });
      const createPendingDecision = pendingDecision ?? (
        /(?:教えてください|補足してください|補足して|言い換えて|確定できない|確認したい|もう少し具体的)/.test(result.reply ?? "")
          ? {
              decision: "new_request" as const,
              persistence: "replace" as const,
              summary: "この create request はまだ補足待ちです。",
            }
          : undefined
      );
      return {
        reply: result.reply ?? "",
        toolCalls: [
          ...(createPendingDecision ? [buildPendingClarificationDecisionToolCall(createPendingDecision.decision, createPendingDecision.persistence, createPendingDecision.summary)] : []),
          buildIntentToolCall({
            intent: "create_work",
            confidence: router.confidence,
            summary: router.reasoningSummary,
          }),
        ],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: "create_work",
          confidence: router.confidence,
          summary: router.reasoningSummary,
        },
        pendingClarificationDecision: createPendingDecision,
      };
    }

    const signal = router.action === "update_progress"
      ? "progress"
      : router.action === "update_completed"
        ? "completed"
        : router.action === "update_blocked"
          ? "blocked"
          : "conversation";
    const updatesResult = await handleManagerUpdates({
      config: args.config,
      repositories,
      message: {
        channelId: input.channelId,
        rootThreadTs: input.rootThreadTs,
        messageTs: input.messageTs,
        userId: input.userId,
        text: input.text,
      },
      now: turnNow,
      signal: signal as ManagerSignal,
      policy,
      followups,
      allowFollowupResolution: !pendingClarification,
      env: {
        ...process.env,
        LINEAR_API_KEY: args.config.linearApiKey,
        LINEAR_WORKSPACE: args.config.linearWorkspace,
        LINEAR_TEAM_KEY: args.config.linearTeamKey,
      },
      helpers: {
        formatReviewFollowupPrompt,
        assessRisk,
        nowIso,
      },
    });

    if (updatesResult?.handled) {
      return {
        reply: updatesResult.reply ?? "",
        toolCalls: [
          ...(pendingDecision ? [buildPendingClarificationDecisionToolCall(pendingDecision.decision, pendingDecision.persistence, pendingDecision.summary)] : []),
          buildIntentToolCall({
            intent: router.action,
            confidence: router.confidence,
            summary: router.reasoningSummary,
          }),
        ],
        proposals: [],
        invalidProposalCount: 0,
        intentReport: {
          intent: router.action,
          confidence: router.confidence,
          summary: router.reasoningSummary,
        },
        pendingClarificationDecision: pendingDecision,
      };
    }

    const candidateIssues = unique([
      planningContext?.thread.latestFocusIssueId,
      planningContext?.thread.lastResolvedIssueId,
      planningContext?.thread.parentIssueId,
      ...(planningContext?.thread.childIssueIds ?? []),
      ...(planningContext?.thread.linkedIssueIds ?? []),
    ]).map((issueId) => ({
      issueId,
      title: [
        planningContext?.latestResolvedIssue,
        planningContext?.parentIssue,
        ...(planningContext?.childIssues ?? []),
        ...(planningContext?.linkedIssues ?? []),
      ].find((issue) => issue?.issueId === issueId)?.title,
    })).filter((issue): issue is { issueId: string; title?: string } => Boolean(issue.issueId));

    const fallbackReply = candidateIssues.length > 0
      ? formatIssueSelectionReply(
        signal,
        buildIssueSelectionCandidates(
          candidateIssues.map((issue) => ({
            issueId: issue.issueId,
            title: issue.title,
            threadKeys: [],
          } as WorkgraphIssueContext)),
        ),
      )
      : classifyManagerSignal(input.text) === "query"
        ? "いまは一覧や優先順位を安全に判断できないため、issue ID か条件をもう少し具体的に教えてください。"
        : "いまは更新対象を安全に確定できないため、`AIC-123` のように issue ID を添えてもう一度送ってください。";

    return {
      reply: fallbackReply,
      toolCalls: [
        ...(pendingDecision ? [buildPendingClarificationDecisionToolCall(pendingDecision.decision, pendingDecision.persistence, pendingDecision.summary)] : []),
        buildIntentToolCall({
          intent: router.action,
          confidence: router.confidence,
          summary: router.reasoningSummary,
        }),
      ],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: {
        intent: router.action,
        confidence: router.confidence,
        summary: router.reasoningSummary,
      },
      pendingClarificationDecision: pendingDecision,
    };
  };
}
