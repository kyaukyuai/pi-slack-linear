import type { LinearCommandEnv, LinearIssue } from "../../lib/linear.js";
import { listRiskyLinearIssues } from "../../lib/linear.js";
import type { ManagerPolicy } from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { RiskAssessment } from "../review/contract.js";
import { assessRisk } from "../review/risk.js";
import {
  buildSlackTargetLabel,
  composeSlackReply,
  formatSlackBullets,
  joinSlackSentences,
} from "../shared/slack-conversation.js";

export type ManagerQueryKind = "list-active" | "list-today" | "what-should-i-do";

export interface QueryHandleResult {
  handled: boolean;
  reply?: string;
}

export interface HandleManagerQueryArgs {
  repositories: Pick<ManagerRepositories, "policy">;
  kind: ManagerQueryKind;
  now: Date;
  env: LinearCommandEnv;
}

const WHAT_SHOULD_I_DO_PATTERN =
  /(?:(?:今日|本日).*(?:やるべき|やること|優先|どれから|何(?:を|から)?(?:すれば|やれば|したら|進めれば))|what should i do)/i;
const LIST_TODAY_PATTERN =
  /(?:今日|本日).*(?:タスク|todo|issue|イシュー|チケット|一覧|確認|見せ|教えて|見たい|チェック|list)/i;
const LIST_ACTIVE_PATTERN =
  /(?:(?:タスク|todo|issue|イシュー|チケット).*(?:一覧|確認|見せ|教えて|見たい|チェック|list)|(?:進行中|稼働中|active).*(?:タスク|todo|issue|イシュー|チケット)?)/i;
const TASK_BREAKDOWN_LINE_PATTERN = /^\s*(?:[-*・•]\s+|\d+[.)]\s+)/;

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
  if (WHAT_SHOULD_I_DO_PATTERN.test(normalized)) return "what-should-i-do";
  if (LIST_TODAY_PATTERN.test(normalized)) return "list-today";
  if (LIST_ACTIVE_PATTERN.test(normalized)) return "list-active";
  return undefined;
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

function computeQueryScore(item: RiskAssessment, policy: ManagerPolicy): number {
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

function buildListTodayReply(items: RankedQueryItem[], policy: ManagerPolicy): string {
  const todayItems = items.filter((item) => isTodayCandidate(item, policy));
  const visible = (todayItems.length > 0 ? todayItems : items).slice(0, 5);
  const intro = todayItems.length > 0
    ? "今日優先して見たい task を整理しました。"
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

function buildWhatShouldIDoReply(items: RankedQueryItem[], policy: ManagerPolicy, now: Date): string {
  if (items.length === 0) {
    return composeSlackReply([
      "いま着手中の task は見当たりません。",
      "新しく進めたい依頼があれば、そのまま送ってください。",
    ]);
  }

  const todayItems = items.filter((item) => isTodayCandidate(item, policy));
  const visible = (todayItems.length > 0 ? todayItems : items).slice(0, 3);
  const top = visible[0];
  const topLabel = top ? buildSlackTargetLabel(top.issue) : undefined;
  const today = toJstDateString(now);
  const intro = todayItems.length > 0
    ? joinSlackSentences([
        `${today} 時点で、今日まず手を付けるなら ${topLabel} から見るのがよさそうです。`,
        "続けて次の候補も挙げます。",
      ])
    : joinSlackSentences([
        `${today} 時点では期限や blocked で強く急ぐものは多くありません。`,
        `手を付けるなら ${topLabel} から見るのがよさそうです。`,
      ]);

  return composeSlackReply([
    intro,
    formatSlackBullets(visible.map((item) => formatQueryIssueLine(item))),
    "必要なら、このまま優先順位を一緒に絞ります。",
  ]);
}

export async function handleManagerQuery({
  repositories,
  kind,
  now,
  env,
}: HandleManagerQueryArgs): Promise<QueryHandleResult> {
  const policy = await repositories.policy.load();
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
        score: computeQueryScore(assessment, policy),
      };
    }),
  );

  const reply = kind === "list-active"
    ? buildListActiveReply(rankedItems)
    : kind === "list-today"
      ? buildListTodayReply(rankedItems, policy)
      : buildWhatShouldIDoReply(rankedItems, policy, now);

  return {
    handled: true,
    reply,
  };
}
