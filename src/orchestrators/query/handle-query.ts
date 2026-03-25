import { getLinearIssue, listRiskyLinearIssues, searchLinearIssues } from "../../lib/linear.js";
import { runManagerReplyTurn } from "../../lib/pi-session.js";
import { getSlackThreadContext } from "../../lib/slack-context.js";
import { buildThreadPaths, ensureThreadWorkspace } from "../../lib/thread-workspace.js";
import { buildWorkgraphThreadKey } from "../../state/workgraph/events.js";
import { getIssueContext, getLatestIssueSource, getThreadPlanningContext } from "../../state/workgraph/queries.js";
import { assessRisk } from "../review/risk.js";
import { classifyManagerQuery, isListContinuationRequest, shouldPreferViewerOwned } from "./query-classification.js";
import type {
  HandleManagerQueryArgs,
  ManagerQueryKind,
  QueryHandleResult,
  QueryMessage,
  QueryPlannerReplyArgs,
  RankedQueryItem,
} from "./query-contract.js";
import {
  buildListActiveReply,
  buildListContinuationReply,
  buildListTodayReply,
  buildQueryContinuationSnapshot,
  buildWhatShouldIDoReply,
  mapRankedItemFacts,
  selectVisibleItemsByIssueIds,
} from "./query-formatting.js";
import {
  buildGenericNextStep,
  buildInspectSelectionReply,
  buildSearchExistingReply,
  deriveSearchQuery,
  formatIssueContextReply,
  formatNextStepReply,
  formatRecentThreadSummary,
  resolveInspectIssue,
} from "./query-inspection.js";
import {
  computeQueryScore,
  isTodayCandidate,
  preferViewerOwnedItems,
  sortRankedItems,
} from "./query-ranking.js";
import {
  RISK_LABELS,
  issueMatchesViewerAssignee,
  resolveViewerOwnerEntry,
  toJstDateString,
  unique,
} from "./query-support.js";

export type {
  HandleManagerQueryArgs,
  ManagerQueryKind,
  ManagerQueryScope,
  QueryContinuationSnapshot,
  QueryHandleResult,
  QueryMessage,
} from "./query-contract.js";
export { classifyManagerQuery } from "./query-classification.js";

async function buildPlannerReply(args: QueryPlannerReplyArgs): Promise<string> {
  const paths = buildThreadPaths(args.config.workspaceDir, args.message.channelId, args.message.rootThreadTs);
  await ensureThreadWorkspace(paths);

  try {
    const result = await runManagerReplyTurn(args.config, paths, {
      kind: args.kind,
      currentDate: toJstDateString(args.now),
      messageText: args.message.text,
      queryScope: args.queryScope,
      facts: args.facts,
      taskKey: `${args.message.channelId}-${args.message.rootThreadTs}-${args.kind}-reply`,
    });
    return result.reply;
  } catch {
    return args.fallbackReply;
  }
}

function buildIssueFacts(issue: Awaited<ReturnType<typeof getLinearIssue>>, fallbackAssignee?: string, fallbackDueDate?: string) {
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    assignee: issue.assignee?.displayName ?? issue.assignee?.name ?? fallbackAssignee ?? "未割当",
    state: issue.state?.name ?? "未設定",
    dueDate: issue.dueDate ?? fallbackDueDate ?? "未設定",
    priorityLabel: issue.priorityLabel ?? undefined,
    cycle: issue.cycle?.name ?? (issue.cycle?.number != null ? String(issue.cycle.number) : undefined),
  };
}

function buildRankedItems(args: {
  issues: Awaited<ReturnType<typeof listRiskyLinearIssues>>;
  now: Date;
  policy: Awaited<ReturnType<HandleManagerQueryArgs["repositories"]["policy"]["load"]>>;
  viewerAssignee?: string;
  preferViewerOwned?: boolean;
}): RankedQueryItem[] {
  return sortRankedItems(
    args.issues.map((issue) => {
      const assessment = assessRisk(issue, args.policy, args.now);
      return {
        issue,
        assessment,
        score: computeQueryScore(assessment, args.policy, {
          viewerAssignee: args.viewerAssignee,
          preferViewerOwned: args.preferViewerOwned,
        }),
        viewerOwned: issueMatchesViewerAssignee(issue, args.viewerAssignee),
      };
    }),
  );
}

export async function handleManagerQuery({
  config,
  repositories,
  kind,
  queryScope,
  message,
  now,
  workspaceDir,
  env,
  lastQueryContext,
}: HandleManagerQueryArgs): Promise<QueryHandleResult> {
  const policy = await repositories.policy.load();
  const ownerMap = await repositories.ownerMap.load();
  const viewerOwnerEntry = resolveViewerOwnerEntry(ownerMap, message.userId);
  const viewerAssignee = viewerOwnerEntry?.linearAssignee;
  const viewerDisplayLabel = viewerAssignee ? `${viewerAssignee} さんの担当` : undefined;
  const preferViewerOwned = shouldPreferViewerOwned(kind, queryScope, message.text, viewerAssignee);
  const viewerMappingMissing = !viewerAssignee && (
    queryScope === "self"
    || kind === "list-today"
    || kind === "what-should-i-do"
    || /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/i.test(message.text)
  );

  if (kind === "reference-material") {
    return {
      handled: true,
      reply: "いまは参照資料の内容を安全に確定できないため、確認したい Notion や資料名をもう少し具体的に教えてください。",
    };
  }

  if (kind === "recommend-next-step") {
    const resolution = await resolveInspectIssue(repositories.workgraph, workspaceDir, message);
    if (!resolution.issueId) {
      return { handled: true, reply: buildInspectSelectionReply(resolution.candidates) };
    }

    const issue = await getLinearIssue(resolution.issueId, env, undefined, { includeComments: true });
    const workgraphIssue = await getIssueContext(repositories.workgraph, resolution.issueId);
    const sourceThread = await getLatestIssueSource(repositories.workgraph, resolution.issueId);
    const assessment = assessRisk(issue, policy, now);
    const recentThreadSummary = await getSlackThreadContext(
      workspaceDir,
      sourceThread?.channelId ?? message.channelId,
      sourceThread?.rootThreadTs ?? message.rootThreadTs,
      12,
    )
      .then((context) => formatRecentThreadSummary(context))
      .catch(() => undefined);
    const fallbackReply = formatNextStepReply({
      issue,
      workgraphIssue,
      assessment,
      sourceThread,
      recentThreadSummary,
    });

    return {
      handled: true,
      reply: await buildPlannerReply({
        config,
        message,
        now,
        kind: "recommend-next-step",
        queryScope,
        facts: {
          issue: buildIssueFacts(issue, workgraphIssue?.assignee, workgraphIssue?.dueDate),
          recentThreadSummary,
          recommendedAction: buildGenericNextStep({ issue, workgraphIssue, assessment }),
          sourceThread,
        },
        fallbackReply,
      }),
      continuation: {
        issueIds: [issue.identifier],
        shownIssueIds: [issue.identifier],
        remainingIssueIds: [],
        totalItemCount: 1,
      },
    };
  }

  if (kind === "inspect-work") {
    const resolution = await resolveInspectIssue(repositories.workgraph, workspaceDir, message);
    if (!resolution.issueId) {
      return { handled: true, reply: buildInspectSelectionReply(resolution.candidates) };
    }

    const issue = await getLinearIssue(resolution.issueId, env, undefined, { includeComments: true });
    const workgraphIssue = await getIssueContext(repositories.workgraph, resolution.issueId);
    const sourceThread = await getLatestIssueSource(repositories.workgraph, resolution.issueId);
    const assessment = assessRisk(issue, policy, now);
    const fallbackReply = formatIssueContextReply({
      issue,
      workgraphIssue,
      assessment,
      sourceThread,
    });

    return {
      handled: true,
      reply: await buildPlannerReply({
        config,
        message,
        now,
        kind: "inspect-work",
        queryScope,
        facts: {
          issue: buildIssueFacts(issue, workgraphIssue?.assignee, workgraphIssue?.dueDate),
          riskReasons: assessment.riskCategories.map((category) => RISK_LABELS[category]).filter(Boolean),
          lastStatus: workgraphIssue?.lastStatus,
          followupStatus: workgraphIssue?.followupStatus,
          parentIssue: issue.parent
            ? {
                identifier: issue.parent.identifier,
                title: issue.parent.title,
                url: issue.parent.url ?? undefined,
              }
            : undefined,
          childIssues: (issue.children ?? []).slice(0, 3).map((child) => ({
            identifier: child.identifier,
            title: child.title,
            url: child.url ?? undefined,
          })),
          sourceThread,
        },
        fallbackReply,
      }),
      continuation: {
        issueIds: [issue.identifier],
        shownIssueIds: [issue.identifier],
        remainingIssueIds: [],
        totalItemCount: 1,
      },
    };
  }

  if (kind === "search-existing") {
    const planningContext = await getThreadPlanningContext(
      repositories.workgraph,
      buildWorkgraphThreadKey(message.channelId, message.rootThreadTs),
    );
    const query = deriveSearchQuery(message.text, planningContext);
    if (!query) {
      return {
        handled: true,
        reply: "既存 issue を探したい対象がまだ絞れていません。task 名かキーワードを少し足してもらえれば、その条件で探します。",
      };
    }

    const issues = await searchLinearIssues({ query, limit: 5 }, env);
    const fallbackReply = buildSearchExistingReply(query, issues);
    return {
      handled: true,
      reply: await buildPlannerReply({
        config,
        message,
        now,
        kind: "search-existing",
        queryScope,
        facts: {
          searchQuery: query,
          issues: issues.slice(0, 5).map((issue) => ({
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url ?? undefined,
            assignee: issue.assignee?.displayName ?? issue.assignee?.name ?? undefined,
            state: issue.state?.name ?? undefined,
            dueDate: issue.dueDate ?? undefined,
          })),
        },
        fallbackReply,
      }),
      continuation: {
        issueIds: issues.slice(0, 5).map((issue) => issue.identifier),
        shownIssueIds: issues.slice(0, 5).map((issue) => issue.identifier),
        remainingIssueIds: [],
        totalItemCount: issues.length,
      },
    };
  }

  const issues = await listRiskyLinearIssues(
    {
      staleBusinessDays: policy.staleBusinessDays,
      urgentPriorityThreshold: policy.urgentPriorityThreshold,
    },
    env,
  );
  const rankedItems = buildRankedItems({
    issues,
    now,
    policy,
    viewerAssignee,
    preferViewerOwned,
  });
  const scopedItems = preferViewerOwned ? preferViewerOwnedItems(rankedItems, viewerAssignee) : rankedItems;
  const todayCandidateItems = scopedItems.filter((item) => isTodayCandidate(item, policy));
  const orderedItems = kind === "list-active"
    ? rankedItems
    : todayCandidateItems.length > 0
      ? todayCandidateItems
      : scopedItems;
  const continuationUniverseItems = kind === "list-active" || queryScope === "self"
    ? orderedItems
    : rankedItems;
  const selectionLimit = kind === "list-active" ? 6 : kind === "list-today" ? 5 : 3;
  const continuationRequested = isListContinuationRequest(kind, queryScope, message.text, lastQueryContext);
  const baseShownIssueIds = lastQueryContext?.shownIssueIds ?? lastQueryContext?.issueIds ?? [];
  const availableIssueIds = new Set(orderedItems.map((item) => item.issue.identifier));
  const continuationPoolIssueIds = continuationRequested
    ? (lastQueryContext?.remainingIssueIds ?? []).filter((issueId) => availableIssueIds.has(issueId))
    : [];
  const visibleItems = continuationRequested
    ? selectVisibleItemsByIssueIds(orderedItems, continuationPoolIssueIds, selectionLimit)
    : orderedItems.slice(0, selectionLimit);
  const visibleIssueIds = visibleItems.map((item) => item.issue.identifier);
  const remainingIssueIds = continuationRequested
    ? continuationPoolIssueIds.filter((issueId) => !visibleIssueIds.includes(issueId))
    : continuationUniverseItems
        .map((item) => item.issue.identifier)
        .filter((issueId) => !visibleIssueIds.includes(issueId));
  const shownIssueIds = continuationRequested
    ? unique([...baseShownIssueIds, ...visibleIssueIds])
    : visibleIssueIds;
  const continuation = buildQueryContinuationSnapshot(visibleItems, unique, {
    shownIssueIds,
    remainingIssueIds,
    totalItemCount: continuationRequested
      ? Math.max(lastQueryContext?.totalItemCount ?? 0, shownIssueIds.length + remainingIssueIds.length)
      : continuationUniverseItems.length,
  });

  const replyFacts = {
    queryScope,
    viewerAssignee: viewerAssignee ?? undefined,
    viewerDisplayLabel,
    viewerMappingMissing,
    itemCount: orderedItems.length,
    continuationRequested,
    selectedItems: visibleItems.map(mapRankedItemFacts),
    shownIssueIds: continuation.shownIssueIds,
    remainingIssueIds: continuation.remainingIssueIds,
    remainingItemCount: continuation.remainingIssueIds.length,
    totalItemCount: continuation.totalItemCount,
  };
  const fallbackReply = kind === "list-active"
    ? continuationRequested
      ? buildListContinuationReply(visibleItems, continuation)
      : buildListActiveReply(rankedItems)
    : kind === "list-today"
      ? buildListTodayReply(rankedItems, policy, { viewerAssignee, viewerDisplayLabel, preferViewerOwned, viewerMappingMissing })
      : buildWhatShouldIDoReply(rankedItems, policy, toJstDateString(now), { viewerAssignee, viewerDisplayLabel, preferViewerOwned, viewerMappingMissing });

  return {
    handled: true,
    reply: await buildPlannerReply({
      config,
      message,
      now,
      kind,
      queryScope,
      facts: replyFacts,
      fallbackReply,
    }),
    continuation,
  };
}
