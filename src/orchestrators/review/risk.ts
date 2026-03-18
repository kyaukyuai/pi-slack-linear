import type { LinearIssue } from "../../lib/linear.js";
import type { ManagerPolicy } from "../../lib/manager-state.js";
import type { RiskAssessment } from "./contract.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstDate(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeRelationType(type: string | null | undefined): string {
  return (type ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function getJstDayString(date: Date): string {
  return toJstDate(date).toISOString().slice(0, 10);
}

export function issueMatchesCompletedState(issue: LinearIssue): boolean {
  const stateName = issue.state?.name?.toLowerCase() ?? "";
  const stateType = issue.state?.type?.toLowerCase() ?? "";
  return ["done", "completed", "canceled", "cancelled"].some(
    (token) => stateName.includes(token) || stateType.includes(token),
  );
}

export function businessDaysSince(updatedAt: string | undefined, now = new Date()): number {
  if (!updatedAt) return Number.MAX_SAFE_INTEGER;
  const start = toJstDate(new Date(updatedAt));
  const end = toJstDate(now);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const target = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  let businessDays = 0;

  while (cursor.getTime() < target.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      businessDays += 1;
    }
  }

  return businessDays;
}

export function assessRisk(issue: LinearIssue, policy: ManagerPolicy, now = new Date()): RiskAssessment {
  const today = getJstDayString(now);
  const tomorrow = getJstDayString(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const dueDate = issue.dueDate ?? undefined;
  const ownerMissing = !issue.assignee;
  const dueMissing = !dueDate;
  const blockedState =
    issue.state?.name?.toLowerCase().includes("block") === true
    || issue.state?.type?.toLowerCase().includes("block") === true;
  const blockedByRelation = (issue.relations ?? []).some((relation) => (
    normalizeRelationType(relation.type).includes("blockedby")
  ));
  const inverseBlockingRelation = (issue.inverseRelations ?? []).some((relation) => {
    const normalized = normalizeRelationType(relation.type);
    return normalized.includes("blocks") || normalized.includes("blockedby");
  });
  const blocked = blockedState || blockedByRelation || inverseBlockingRelation;
  const staleDays = businessDaysSince(issue.updatedAt ?? undefined, now);
  const riskCategories: string[] = [];

  if (dueDate) {
    if (dueDate < today) {
      riskCategories.push("overdue");
    } else if (dueDate === today) {
      riskCategories.push("due_today");
    } else if (dueDate === tomorrow) {
      riskCategories.push("due_soon");
    }
  }

  if (staleDays >= policy.staleBusinessDays) {
    riskCategories.push("stale");
  }
  if (blocked) {
    riskCategories.push("blocked");
  }
  if (ownerMissing) {
    riskCategories.push("owner_missing");
  }
  if (dueMissing) {
    riskCategories.push("due_missing");
  }

  return {
    issue,
    riskCategories: unique(riskCategories),
    ownerMissing,
    dueMissing,
    blocked,
    businessDaysSinceUpdate: staleDays,
  };
}
