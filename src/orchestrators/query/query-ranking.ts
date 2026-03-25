import type { ManagerPolicy } from "../../state/manager-state-contract.js";
import type { RiskAssessment } from "../review/contract.js";
import type { RankedQueryItem } from "./query-contract.js";
import { compareDueDates, issueMatchesViewerAssignee, issuePriorityRank } from "./query-support.js";

export function computeQueryScore(
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

export function sortRankedItems(items: RankedQueryItem[]): RankedQueryItem[] {
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

export function isTodayCandidate(item: RankedQueryItem, policy: ManagerPolicy): boolean {
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

export function preferViewerOwnedItems(
  items: RankedQueryItem[],
  viewerAssignee: string | undefined,
): RankedQueryItem[] {
  if (!viewerAssignee) return items;
  const owned = items.filter((item) => item.viewerOwned);
  return owned.length > 0 ? owned : items;
}
