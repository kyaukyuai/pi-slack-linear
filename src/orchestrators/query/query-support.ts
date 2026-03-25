import type { LinearIssue } from "../../lib/linear.js";
import type { OwnerMap, OwnerMapEntry } from "../../state/manager-state-contract.js";
import type { RankedQueryItem } from "./query-contract.js";

export const RISK_LABELS: Record<string, string> = {
  overdue: "期限超過",
  due_today: "今日が期限",
  due_soon: "明日が期限",
  blocked: "blocked",
  stale: "更新が止まり気味",
  owner_missing: "担当未設定",
  due_missing: "期限未設定",
};

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function normalizeComparableText(text: string | null | undefined): string {
  return (text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

export function resolveViewerOwnerEntry(ownerMap: OwnerMap, slackUserId: string): OwnerMapEntry | undefined {
  return ownerMap.entries.find((entry) => entry.slackUserId === slackUserId);
}

export function issueMatchesViewerAssignee(issue: LinearIssue, viewerAssignee: string | undefined): boolean {
  if (!viewerAssignee) return false;
  const normalizedViewer = normalizeComparableText(viewerAssignee);
  return [
    issue.assignee?.displayName,
    issue.assignee?.name,
    issue.assignee?.email,
  ].some((value) => normalizeComparableText(value) === normalizedViewer);
}

export function toJstDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function compareDueDates(left: LinearIssue, right: LinearIssue): number {
  if (left.dueDate && right.dueDate) {
    return left.dueDate.localeCompare(right.dueDate);
  }
  if (left.dueDate) return -1;
  if (right.dueDate) return 1;
  return 0;
}

export function issuePriorityRank(issue: LinearIssue): number {
  const priority = issue.priority ?? 99;
  return priority > 0 ? priority : 99;
}

export function formatRiskReasons(categories: string[]): string | undefined {
  const labels = categories
    .map((category) => RISK_LABELS[category])
    .filter(Boolean);
  if (labels.length === 0) return undefined;
  return labels.join("、");
}

export function mapRankedItemFacts(item: RankedQueryItem): Record<string, unknown> {
  return {
    identifier: item.issue.identifier,
    title: item.issue.title,
    url: item.issue.url ?? undefined,
    assignee: item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? "未割当",
    dueDate: item.issue.dueDate ?? "未設定",
    state: item.issue.state?.name ?? undefined,
    priorityLabel: item.issue.priorityLabel ?? undefined,
    cycle: item.issue.cycle?.name ?? (item.issue.cycle?.number != null ? String(item.issue.cycle.number) : undefined),
    riskReasons: item.assessment.riskCategories.map((category) => RISK_LABELS[category]).filter(Boolean),
    viewerOwned: item.viewerOwned,
  };
}
