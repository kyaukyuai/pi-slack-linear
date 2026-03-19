import {
  getLinearIssue,
  listRiskyLinearIssues,
  searchLinearIssues,
  type LinearCommandEnv,
  type LinearIssue,
} from "../../lib/linear.js";
import { getSlackThreadContext } from "../../lib/slack-context.js";
import { buildWorkgraphThreadKey } from "../../state/workgraph/events.js";
import {
  getIssueContext,
  getLatestIssueSource,
  getThreadPlanningContext,
  type WorkgraphIssueContext,
  type WorkgraphThreadPlanningContext,
} from "../../state/workgraph/queries.js";
import type { ManagerPolicy, OwnerMap, OwnerMapEntry } from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { RiskAssessment } from "../review/contract.js";
import { assessRisk } from "../review/risk.js";
import {
  buildSlackTargetLabel,
  composeSlackReply,
  formatSlackBullets,
  joinSlackSentences,
} from "../shared/slack-conversation.js";

export type ManagerQueryKind =
  | "list-active"
  | "list-today"
  | "what-should-i-do"
  | "inspect-work"
  | "search-existing";

export interface QueryHandleResult {
  handled: boolean;
  reply?: string;
}

export interface QueryMessage {
  channelId: string;
  rootThreadTs: string;
  userId: string;
  text: string;
}

export interface HandleManagerQueryArgs {
  repositories: Pick<ManagerRepositories, "policy" | "ownerMap" | "workgraph">;
  kind: ManagerQueryKind;
  message: QueryMessage;
  now: Date;
  workspaceDir: string;
  env: LinearCommandEnv;
}

const WHAT_SHOULD_I_DO_PATTERN =
  /(?:(?:今日|本日).*(?:やるべき|やること|優先|どれから|何(?:を|から)?(?:すれば|やれば|したら|進めれば))|what should i do)/i;
const LIST_TODAY_PATTERN =
  /(?:今日|本日).*(?:タスク|todo|issue|イシュー|チケット|一覧|確認|見せ|教えて|見たい|チェック|list)/i;
const LIST_ACTIVE_PATTERN =
  /(?:(?:タスク|todo|issue|イシュー|チケット).*(?:一覧|確認|見せ|教えて|見たい|チェック|list)|(?:進行中|稼働中|active).*(?:タスク|todo|issue|イシュー|チケット)?)/i;
const INSPECT_WORK_PATTERN =
  /(?:(?:\b[A-Z][A-Z0-9]+-\d+\b|この件|その件|このタスク|そのタスク|このissue|そのissue|このイシュー|そのイシュー).*(?:状況|状態|進捗|詳細|どうなってる|どうなっています|どこまで|止まってる|止まっている|見せて|教えて|知りたい|確認したい)|(?:状況|状態|進捗|詳細|どこまで|どうなってる|止まってる).*(?:教えて|見せて|知りたい|確認したい|[?？]))/i;
const SEARCH_EXISTING_PATTERN =
  /(?:(?:既存|同じ|似た|重複).*(?:issue|イシュー|task|タスク|チケット).*(?:ある|あります|あったっけ|探して|検索|確認)|(?:issue|イシュー|task|タスク|チケット).*(?:既存|同じ|似た|重複).*(?:ある|あります|あったっけ|探して|検索|確認)|(?:既に|すでに).*(?:登録|起票).*(?:されてる|されている|ある|あります))/i;
const TASK_BREAKDOWN_LINE_PATTERN = /^\s*(?:[-*・•]\s+|\d+[.)]\s+)/;
const SELF_WORK_PATTERN = /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/i;

const RISK_LABELS: Record<string, string> = {
  overdue: "期限を過ぎています",
  due_today: "今日が期限です",
  due_soon: "明日が期限です",
  blocked: "blocked です",
  stale: "更新が止まり気味です",
  owner_missing: "担当が未設定です",
  due_missing: "期限が未設定です",
};

interface RankedQueryItem {
  issue: LinearIssue;
  assessment: RiskAssessment;
  score: number;
  viewerOwned: boolean;
}

interface InspectResolution {
  issueId?: string;
  candidates: Array<{ issueId: string; title?: string; url?: string | null }>;
}

interface InspectCandidateScore {
  issueId: string;
  title?: string;
  url?: string | null;
  score: number;
}

export function classifyManagerQuery(text: string): ManagerQueryKind | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const taskBreakdownLineCount = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => TASK_BREAKDOWN_LINE_PATTERN.test(line))
    .length;
  if (taskBreakdownLineCount >= 2) return undefined;
  if (SEARCH_EXISTING_PATTERN.test(normalized)) return "search-existing";
  if (INSPECT_WORK_PATTERN.test(normalized)) return "inspect-work";
  if (WHAT_SHOULD_I_DO_PATTERN.test(normalized)) return "what-should-i-do";
  if (LIST_TODAY_PATTERN.test(normalized)) return "list-today";
  if (LIST_ACTIVE_PATTERN.test(normalized)) return "list-active";
  return undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeComparableText(text: string | null | undefined): string {
  return (text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

function resolveViewerOwnerEntry(ownerMap: OwnerMap, slackUserId: string): OwnerMapEntry | undefined {
  return ownerMap.entries.find((entry) => entry.slackUserId === slackUserId);
}

function issueMatchesViewerAssignee(issue: LinearIssue, viewerAssignee: string | undefined): boolean {
  if (!viewerAssignee) return false;
  const normalizedViewer = normalizeComparableText(viewerAssignee);
  return [
    issue.assignee?.displayName,
    issue.assignee?.name,
    issue.assignee?.email,
  ].some((value) => normalizeComparableText(value) === normalizedViewer);
}

function toJstDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function compareDueDates(left: LinearIssue, right: LinearIssue): number {
  if (left.dueDate && right.dueDate) {
    return left.dueDate.localeCompare(right.dueDate);
  }
  if (left.dueDate) return -1;
  if (right.dueDate) return 1;
  return 0;
}

function issuePriorityRank(issue: LinearIssue): number {
  const priority = issue.priority ?? 99;
  return priority > 0 ? priority : 99;
}

function computeQueryScore(
  item: RiskAssessment,
  policy: ManagerPolicy,
  options?: { viewerAssignee?: string; preferViewerOwned?: boolean },
): number {
  let score = 0;
  const categories = new Set(item.riskCategories);

  if (categories.has("overdue")) score += 1000;
  if (categories.has("due_today")) score += 900;
  if (categories.has("blocked")) score += 850;
  if (categories.has("due_soon")) score += 700;
  if (categories.has("stale")) score += 450;
  if (categories.has("owner_missing")) score += 200;
  if (categories.has("due_missing")) score += 120;

  const priority = issuePriorityRank(item.issue);
  if (priority <= policy.urgentPriorityThreshold) {
    score += 250 - (priority * 10);
  } else if (priority < 99) {
    score += 70 - (priority * 5);
  }

  if (issueMatchesViewerAssignee(item.issue, options?.viewerAssignee)) {
    score += options?.preferViewerOwned ? 600 : 140;
  } else if (options?.preferViewerOwned) {
    score -= 120;
  }

  return score;
}

function sortRankedItems(items: RankedQueryItem[]): RankedQueryItem[] {
  return [...items].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    const dueDateOrder = compareDueDates(left.issue, right.issue);
    if (dueDateOrder !== 0) {
      return dueDateOrder;
    }

    const priorityOrder = issuePriorityRank(left.issue) - issuePriorityRank(right.issue);
    if (priorityOrder !== 0) {
      return priorityOrder;
    }

    return left.issue.identifier.localeCompare(right.issue.identifier);
  });
}

function isTodayCandidate(item: RankedQueryItem, policy: ManagerPolicy): boolean {
  const categories = new Set(item.assessment.riskCategories);
  if (
    categories.has("overdue")
    || categories.has("due_today")
    || categories.has("due_soon")
    || categories.has("blocked")
  ) {
    return true;
  }

  return issuePriorityRank(item.issue) <= policy.urgentPriorityThreshold;
}

function formatRiskReasons(categories: string[]): string | undefined {
  const labels = categories
    .map((category) => RISK_LABELS[category])
    .filter(Boolean);
  if (labels.length === 0) return undefined;
  return labels.join("、");
}

function formatQueryIssueLine(item: RankedQueryItem): string {
  const assignee = item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? "未割当";
  const due = item.issue.dueDate ?? "未設定";
  const state = item.issue.state?.name;
  const priority = item.issue.priorityLabel;
  const cycle = item.issue.cycle?.name ?? (item.issue.cycle?.number != null ? String(item.issue.cycle.number) : undefined);
  const reason = formatRiskReasons(item.assessment.riskCategories);

  return joinSlackSentences([
    `${buildSlackTargetLabel(item.issue)}。`,
    `担当は ${assignee} です。`,
    `期限は ${due} です。`,
    state ? `状態は ${state} です。` : undefined,
    priority ? `優先度は ${priority} です。` : undefined,
    cycle ? `Cycle は ${cycle} です。` : undefined,
    reason ? `今見ておきたい理由は ${reason} です。` : "現時点では大きなリスクは強く出ていません。",
  ]) ?? buildSlackTargetLabel(item.issue);
}

function extractIssueIdentifiers(text: string): string[] {
  return unique(
    Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
      .map((match) => match[1] ?? "")
      .filter(Boolean),
  );
}

function threadPlanningCandidates(
  planningContext: WorkgraphThreadPlanningContext | undefined,
): Array<{ issueId: string; title?: string; url?: string | null }> {
  if (!planningContext) return [];

  return unique([
    planningContext.thread.latestFocusIssueId,
    planningContext.thread.lastResolvedIssueId,
    planningContext.parentIssue?.issueId,
    ...planningContext.childIssues.map((issue) => issue.issueId),
    ...planningContext.linkedIssues.map((issue) => issue.issueId),
  ].filter(Boolean) as string[]).map((issueId) => {
    const issue = [
      planningContext.parentIssue,
      ...planningContext.childIssues,
      ...planningContext.linkedIssues,
      planningContext.latestResolvedIssue,
    ].find((candidate) => candidate?.issueId === issueId);

    return {
      issueId,
      title: issue?.title,
      url: undefined,
    };
  });
}

function matchIssueMentionScore(
  sourceText: string,
  candidate: { issueId: string; title?: string },
): number {
  const normalizedSource = normalizeComparableText(sourceText);
  if (!normalizedSource) return 0;

  let score = 0;
  if (normalizedSource.includes(candidate.issueId.toLowerCase())) {
    score += 40;
  }

  const normalizedTitle = normalizeComparableText(candidate.title);
  if (normalizedTitle.length >= 2) {
    if (normalizedSource.includes(normalizedTitle)) {
      score += 28;
    } else if (normalizedTitle.includes(normalizedSource) && normalizedSource.length >= 2) {
      score += 8;
    }
  }

  return score;
}

async function scoreInspectCandidates(args: {
  workspaceDir: string;
  message: QueryMessage;
  planningContext: WorkgraphThreadPlanningContext | undefined;
  candidates: Array<{ issueId: string; title?: string; url?: string | null }>;
}): Promise<InspectCandidateScore[]> {
  const recentContext = await getSlackThreadContext(
    args.workspaceDir,
    args.message.channelId,
    args.message.rootThreadTs,
    12,
  ).catch(() => undefined);

  const recentEntries = recentContext?.entries.slice(-6) ?? [];

  return args.candidates.map((candidate) => {
    let score = matchIssueMentionScore(args.message.text, candidate);
    if (args.planningContext?.thread.latestFocusIssueId === candidate.issueId) {
      score += 70;
    }
    if (args.planningContext?.thread.lastResolvedIssueId === candidate.issueId) {
      score += 45;
    }

    recentEntries.forEach((entry, index) => {
      const recencyWeight = recentEntries.length - index;
      score += matchIssueMentionScore(entry.text, candidate) * recencyWeight;
    });

    return {
      ...candidate,
      score,
    };
  });
}

async function resolveInspectIssue(
  repository: Pick<ManagerRepositories, "workgraph">["workgraph"],
  workspaceDir: string,
  message: QueryMessage,
): Promise<InspectResolution> {
  const explicitIssueIds = extractIssueIdentifiers(message.text);
  if (explicitIssueIds.length === 1) {
    return {
      issueId: explicitIssueIds[0],
      candidates: explicitIssueIds.map((issueId) => ({ issueId })),
    };
  }
  if (explicitIssueIds.length > 1) {
    return {
      candidates: explicitIssueIds.map((issueId) => ({ issueId })),
    };
  }

  const planningContext = await getThreadPlanningContext(
    repository,
    buildWorkgraphThreadKey(message.channelId, message.rootThreadTs),
  );
  const candidates = threadPlanningCandidates(planningContext);

  if (candidates.length === 1) {
    return {
      issueId: candidates[0]?.issueId,
      candidates,
    };
  }
  if (candidates.length >= 2) {
    const scored = await scoreInspectCandidates({
      workspaceDir,
      message,
      planningContext,
      candidates,
    });
    scored.sort((left, right) => right.score - left.score);
    const top = scored[0];
    const second = scored[1];
    if (top && top.score >= 70 && top.score - (second?.score ?? 0) >= 20) {
      return {
        issueId: top.issueId,
        candidates,
      };
    }
  }

  if (planningContext?.thread.latestFocusIssueId) {
    return {
      issueId: planningContext.thread.latestFocusIssueId,
      candidates,
    };
  }
  if (planningContext?.thread.lastResolvedIssueId) {
    return {
      issueId: planningContext.thread.lastResolvedIssueId,
      candidates,
    };
  }

  return { candidates };
}

function buildInspectSelectionReply(candidates: Array<{ issueId: string; title?: string; url?: string | null }>): string {
  if (candidates.length === 0) {
    return composeSlackReply([
      "どの issue の状況を見るべきか、まだ決めきれていません。",
      "issue ID か task 名をもう少し具体的に教えてください。",
    ]);
  }

  return composeSlackReply([
    "見たい issue が複数ありそうなので、対象を絞りたいです。",
    formatSlackBullets(
      candidates.map((candidate) => (
        candidate.title
          ? `${candidate.issueId} ${candidate.title}`
          : candidate.issueId
      )),
    ),
    "見たい issue ID を返してもらえれば、その状況をすぐ確認します。",
  ]);
}

function formatIssueHealthSummary(issue: LinearIssue, assessment: RiskAssessment): string | undefined {
  const reasons = formatRiskReasons(assessment.riskCategories);
  if (!reasons) {
    return "直近で強いリスクは見えていません。";
  }
  return `今気になっている点は ${reasons} です。`;
}

function formatIssueContextReply(args: {
  issue: LinearIssue;
  workgraphIssue?: WorkgraphIssueContext;
  assessment: RiskAssessment;
  sourceThread?: Awaited<ReturnType<typeof getLatestIssueSource>>;
}): string {
  const assignee = args.issue.assignee?.displayName ?? args.issue.assignee?.name ?? args.workgraphIssue?.assignee ?? "未割当";
  const state = args.issue.state?.name ?? "未設定";
  const due = args.issue.dueDate ?? args.workgraphIssue?.dueDate ?? "未設定";
  const priority = args.issue.priorityLabel;
  const cycle = args.issue.cycle?.name ?? (args.issue.cycle?.number != null ? String(args.issue.cycle.number) : undefined);
  const parent = args.issue.parent;
  const children = args.issue.children ?? [];
  const latestThreadStatus = args.workgraphIssue?.lastStatus;
  const followupStatus = args.workgraphIssue?.followupStatus;

  return composeSlackReply([
    joinSlackSentences([
      `${buildSlackTargetLabel(args.issue)} の状況を確認しました。`,
      `担当は ${assignee} です。`,
      `状態は ${state} です。`,
      `期限は ${due} です。`,
      priority ? `優先度は ${priority} です。` : undefined,
      cycle ? `Cycle は ${cycle} です。` : undefined,
    ]),
    joinSlackSentences([
      formatIssueHealthSummary(args.issue, args.assessment),
      latestThreadStatus ? `thread 上で最後に見えている更新は ${latestThreadStatus} です。` : undefined,
      followupStatus === "awaiting-response"
        ? "いまは follow-up の返答待ちです。"
        : followupStatus === "resolved"
          ? "follow-up はいったん解消しています。"
          : undefined,
    ]),
    joinSlackSentences([
      parent ? `親 issue は ${buildSlackTargetLabel(parent)} です。` : undefined,
      children.length > 0 ? `子 issue は ${children.slice(0, 3).map((child) => buildSlackTargetLabel(child)).join("、")} です。` : undefined,
    ]),
    args.sourceThread
      ? `元の thread は channel ${args.sourceThread.channelId} / thread ${args.sourceThread.rootThreadTs} です。`
      : undefined,
  ]);
}

function stripSearchIntentWords(text: string): string {
  return text
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ")
    .replace(/(?:既存|同じ|似た|重複|過去|前に|以前|すでに|既に)/g, " ")
    .replace(/(?:issue|イシュー|task|タスク|チケット|ticket|todo)/gi, " ")
    .replace(/(?:ある|あります|あったっけ|ありますか|探して|検索して|検索|確認して|確認したい|見せて|教えて|知りたい|ないか|残ってる)/g, " ")
    .replace(/[?？。！!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveSearchQuery(
  text: string,
  planningContext: WorkgraphThreadPlanningContext | undefined,
): string | undefined {
  const stripped = stripSearchIntentWords(text);
  if (stripped.length >= 2) {
    return stripped;
  }

  return planningContext?.latestResolvedIssue?.title
    ?? planningContext?.parentIssue?.title
    ?? planningContext?.childIssues[0]?.title
    ?? planningContext?.linkedIssues[0]?.title
    ?? planningContext?.thread.originalText;
}

function buildSearchExistingReply(query: string, issues: LinearIssue[]): string {
  if (issues.length === 0) {
    return composeSlackReply([
      `「${query}」で既存 issue を探しましたが、近いものはまだ見当たりませんでした。`,
      "必要ならこのまま新規 task として登録できます。",
    ]);
  }

  if (issues.length === 1) {
    return composeSlackReply([
      `「${query}」で探したところ、近い既存 issue が見つかりました。`,
      `対象は ${buildSlackTargetLabel(issues[0])} です。`,
      "新規起票せずに寄せるなら、この issue を使うのがよさそうです。",
    ]);
  }

  return composeSlackReply([
    `「${query}」で探したところ、近い既存 issue が複数見つかりました。`,
    formatSlackBullets(
      issues.slice(0, 5).map((issue) => (
        joinSlackSentences([
          `${buildSlackTargetLabel(issue)}。`,
          issue.state?.name ? `状態は ${issue.state.name} です。` : undefined,
          issue.assignee?.displayName ?? issue.assignee?.name ? `担当は ${issue.assignee?.displayName ?? issue.assignee?.name} です。` : undefined,
          issue.dueDate ? `期限は ${issue.dueDate} です。` : undefined,
        ]) ?? buildSlackTargetLabel(issue)
      )),
    ),
    "寄せたいものがあれば issue ID を返してください。新規に切るなら、そのまま task 追加の依頼を送ってもらえれば進めます。",
  ]);
}

function preferViewerOwnedItems(
  items: RankedQueryItem[],
  viewerAssignee: string | undefined,
): RankedQueryItem[] {
  if (!viewerAssignee) return items;
  const owned = items.filter((item) => item.viewerOwned);
  return owned.length > 0 ? owned : items;
}

function buildListActiveReply(items: RankedQueryItem[]): string {
  if (items.length === 0) {
    return composeSlackReply([
      "いま active な task は見当たりません。",
      "新しく進めたい依頼があれば、そのままこの channel で送ってください。",
    ]);
  }

  const visible = items.slice(0, 6);
  const overflow = items.length > visible.length
    ? `全体では ${items.length} 件あり、ここでは優先して見やすいものを ${visible.length} 件だけ出しています。`
    : `いま動いている task は ${items.length} 件です。`;

  return composeSlackReply([
    joinSlackSentences([
      "タスク一覧を確認しました。",
      overflow,
    ]),
    formatSlackBullets(visible.map((item) => formatQueryIssueLine(item))),
    "気になる issue があれば、issue ID を返してもらえれば詳細も追えます。",
  ]);
}

function buildListTodayReply(
  items: RankedQueryItem[],
  policy: ManagerPolicy,
  options?: { viewerAssignee?: string; viewerDisplayLabel?: string; preferViewerOwned?: boolean },
): string {
  const scopedItems = options?.preferViewerOwned ? preferViewerOwnedItems(items, options.viewerAssignee) : items;
  const todayItems = scopedItems.filter((item) => isTodayCandidate(item, policy));
  const visible = (todayItems.length > 0 ? todayItems : scopedItems).slice(0, 5);
  const intro = todayItems.length > 0
    ? options?.preferViewerOwned && options.viewerAssignee && visible.every((item) => item.viewerOwned)
      ? `${options.viewerDisplayLabel ?? "担当中のもの"} を基準に、今日優先して見たい task を整理しました。`
      : "今日優先して見たい task を整理しました。"
    : options?.preferViewerOwned && options.viewerAssignee
      ? `${options.viewerDisplayLabel ?? "担当中のもの"} では期限や blocked が強い task は多くありません。手を付けるなら次の順がよさそうです。`
      : "今日は期限や blocked で強く急ぐ task は多くありません。手を付けるなら次の順がよさそうです。";

  if (visible.length === 0) {
    return composeSlackReply([
      "今日は優先して動くべき active task は見当たりません。",
      "新しい依頼があれば、そのままこの channel で送ってください。",
    ]);
  }

  return composeSlackReply([
    intro,
    formatSlackBullets(visible.map((item) => formatQueryIssueLine(item))),
    "進めるものが決まったら、その issue ID か thread で進捗を返してください。",
  ]);
}

function buildWhatShouldIDoReply(
  items: RankedQueryItem[],
  policy: ManagerPolicy,
  now: Date,
  options?: { viewerAssignee?: string; viewerDisplayLabel?: string; preferViewerOwned?: boolean },
): string {
  if (items.length === 0) {
    return composeSlackReply([
      "いま着手中の task は見当たりません。",
      "新しく進めたい依頼があれば、そのまま送ってください。",
    ]);
  }

  const scopedItems = options?.preferViewerOwned ? preferViewerOwnedItems(items, options.viewerAssignee) : items;
  const todayItems = scopedItems.filter((item) => isTodayCandidate(item, policy));
  const visible = (todayItems.length > 0 ? todayItems : scopedItems).slice(0, 3);
  const top = visible[0];
  const topLabel = top ? buildSlackTargetLabel(top.issue) : undefined;
  const today = toJstDateString(now);
  const intro = todayItems.length > 0
    ? joinSlackSentences([
        options?.preferViewerOwned && options.viewerAssignee && top?.viewerOwned
          ? `${today} 時点で、${options.viewerDisplayLabel ?? "担当中のもの"}の中では ${topLabel} から見るのがよさそうです。`
          : `${today} 時点で、今日まず手を付けるなら ${topLabel} から見るのがよさそうです。`,
        "続けて次の候補も挙げます。",
      ])
    : joinSlackSentences([
        options?.preferViewerOwned && options.viewerAssignee
          ? `${today} 時点では ${options.viewerDisplayLabel ?? "担当中のもの"}で期限や blocked が強く急ぐものは多くありません。`
          : `${today} 時点では期限や blocked で強く急ぐものは多くありません。`,
        `手を付けるなら ${topLabel} から見るのがよさそうです。`,
      ]);

  return composeSlackReply([
    intro,
    formatSlackBullets(visible.map((item) => formatQueryIssueLine(item))),
    "必要なら、このまま優先順位を一緒に絞ります。",
  ]);
}

function shouldPreferViewerOwned(kind: ManagerQueryKind, text: string, viewerAssignee: string | undefined): boolean {
  if (!viewerAssignee) return false;
  if (SELF_WORK_PATTERN.test(text)) return true;
  return kind === "what-should-i-do" || kind === "list-today";
}

export async function handleManagerQuery({
  repositories,
  kind,
  message,
  now,
  workspaceDir,
  env,
}: HandleManagerQueryArgs): Promise<QueryHandleResult> {
  const policy = await repositories.policy.load();
  const ownerMap = await repositories.ownerMap.load();
  const viewerOwnerEntry = resolveViewerOwnerEntry(ownerMap, message.userId);
  const viewerAssignee = viewerOwnerEntry?.linearAssignee;
  const viewerDisplayLabel = viewerAssignee ? `${viewerAssignee} さんの担当` : undefined;
  const preferViewerOwned = shouldPreferViewerOwned(kind, message.text, viewerAssignee);

  if (kind === "inspect-work") {
    const resolution = await resolveInspectIssue(repositories.workgraph, workspaceDir, message);
    if (!resolution.issueId) {
      return {
        handled: true,
        reply: buildInspectSelectionReply(resolution.candidates),
      };
    }

    const issue = await getLinearIssue(resolution.issueId, env, undefined, { includeComments: true });
    const workgraphIssue = await getIssueContext(repositories.workgraph, resolution.issueId);
    const sourceThread = await getLatestIssueSource(repositories.workgraph, resolution.issueId);
    return {
      handled: true,
      reply: formatIssueContextReply({
        issue,
        workgraphIssue,
        assessment: assessRisk(issue, policy, now),
        sourceThread,
      }),
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
        reply: composeSlackReply([
          "既存 issue を探したい対象がまだ絞れていません。",
          "task 名かキーワードを少し足してもらえれば、その条件で探します。",
        ]),
      };
    }

    const issues = await searchLinearIssues({ query, limit: 5 }, env);
    return {
      handled: true,
      reply: buildSearchExistingReply(query, issues),
    };
  }

  const issues = await listRiskyLinearIssues(
    {
      staleBusinessDays: policy.staleBusinessDays,
      urgentPriorityThreshold: policy.urgentPriorityThreshold,
    },
    env,
  );
  const rankedItems = sortRankedItems(
    issues.map((issue) => {
      const assessment = assessRisk(issue, policy, now);
      return {
        issue,
        assessment,
        score: computeQueryScore(assessment, policy, { viewerAssignee, preferViewerOwned }),
        viewerOwned: issueMatchesViewerAssignee(issue, viewerAssignee),
      };
    }),
  );

  const reply = kind === "list-active"
    ? buildListActiveReply(rankedItems)
    : kind === "list-today"
      ? buildListTodayReply(rankedItems, policy, { viewerAssignee, viewerDisplayLabel, preferViewerOwned })
      : buildWhatShouldIDoReply(rankedItems, policy, now, { viewerAssignee, viewerDisplayLabel, preferViewerOwned });

  return {
    handled: true,
    reply,
  };
}
