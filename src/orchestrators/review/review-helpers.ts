import type {
  FollowupLedgerEntry,
  ManagerPolicy,
  OwnerMap,
} from "../../state/manager-state-contract.js";
import type {
  ManagerReviewFollowup,
  ManagerReviewIssueLine,
  ManagerReviewResult,
  RiskAssessment,
} from "./contract.js";

export interface ReviewHelperDeps {
  nowIso(now: Date): string;
  normalizeText(text: string): string;
  toJstDate(date: Date): Date;
}

export function getPrimaryRiskCategory(item: RiskAssessment): string {
  const rank: Record<string, number> = {
    overdue: 0,
    due_today: 1,
    blocked: 2,
    stale: 3,
    due_soon: 4,
    owner_missing: 5,
    due_missing: 6,
  };

  return [...item.riskCategories].sort((left, right) => (rank[left] ?? 99) - (rank[right] ?? 99))[0] ?? "review";
}

export function formatReviewFollowupPrompt(item: RiskAssessment): string {
  const primaryCategory = getPrimaryRiskCategory(item);
  if (primaryCategory === "blocked") {
    return "原因と、誰の返答待ちか、何がそろえば再開できるかを共有してください。";
  }
  if (primaryCategory === "overdue" || primaryCategory === "due_today" || primaryCategory === "due_soon") {
    return "現在の進捗と次アクション、次回更新予定を共有してください。";
  }
  if (primaryCategory === "owner_missing") {
    return "担当者を 1 人決めて共有してください。";
  }
  if (primaryCategory === "due_missing") {
    return "期限を YYYY-MM-DD で共有してください。";
  }
  return "最新状況と次アクション、次回更新予定を共有してください。";
}

export function requestKindForRiskCategory(category: string): ManagerReviewFollowup["requestKind"] {
  if (category === "blocked") return "blocked-details";
  if (category === "owner_missing") return "owner";
  if (category === "due_missing") return "due-date";
  return "status";
}

export function acceptableAnswerHintForRequestKind(
  requestKind: ManagerReviewFollowup["requestKind"],
): string {
  if (requestKind === "blocked-details") {
    return "原因 / 待ち先 / 再開条件";
  }
  if (requestKind === "owner") {
    return "担当者名";
  }
  if (requestKind === "due-date") {
    return "YYYY-MM-DD";
  }
  return "進捗 / 次アクション / 次回更新予定";
}

function resolveSlackUserIdForReview(
  ownerMap: OwnerMap,
  assigneeDisplayName: string | undefined,
  deps: Pick<ReviewHelperDeps, "normalizeText">,
): string | undefined {
  if (!assigneeDisplayName) return undefined;
  const normalizedAssignee = deps.normalizeText(assigneeDisplayName);
  return ownerMap.entries.find((entry) => {
    if (!entry.slackUserId) return false;
    return deps.normalizeText(entry.linearAssignee) === normalizedAssignee
      || deps.normalizeText(entry.id) === normalizedAssignee;
  })?.slackUserId;
}

function shouldMentionReviewFollowup(
  category: string,
  existingFollowup?: FollowupLedgerEntry,
): boolean {
  if (["blocked", "overdue", "due_today"].includes(category)) {
    return true;
  }
  return existingFollowup?.status === "awaiting-response" && Boolean(existingFollowup.lastPublicFollowupAt);
}

export function buildReviewFollowup(
  item: RiskAssessment,
  ownerMap: OwnerMap,
  existingFollowup: FollowupLedgerEntry | undefined,
  issueSources: Record<string, ManagerReviewFollowup["source"]>,
  deps: Pick<ReviewHelperDeps, "normalizeText">,
): ManagerReviewFollowup {
  const riskCategory = getPrimaryRiskCategory(item);
  const requestKind = existingFollowup?.requestKind ?? requestKindForRiskCategory(riskCategory);
  const assigneeDisplayName = existingFollowup?.assigneeDisplayName
    ?? item.issue.assignee?.displayName
    ?? item.issue.assignee?.name
    ?? undefined;
  return {
    issueId: item.issue.identifier,
    issueTitle: item.issue.title,
    issueUrl: item.issue.url,
    request: existingFollowup?.requestText ?? formatReviewFollowupPrompt(item),
    requestKind,
    acceptableAnswerHint: existingFollowup?.acceptableAnswerHint
      ?? acceptableAnswerHintForRequestKind(requestKind),
    assigneeDisplayName,
    slackUserId: resolveSlackUserIdForReview(ownerMap, assigneeDisplayName, deps),
    riskCategory,
    shouldMention: shouldMentionReviewFollowup(riskCategory, existingFollowup),
    source: existingFollowup?.sourceChannelId && existingFollowup?.sourceThreadTs && existingFollowup?.sourceMessageTs
      ? {
          channelId: existingFollowup.sourceChannelId,
          rootThreadTs: existingFollowup.sourceThreadTs,
          sourceMessageTs: existingFollowup.sourceMessageTs,
        }
      : issueSources[item.issue.identifier],
  };
}

export function buildAwaitingFollowupPatch(
  followups: FollowupLedgerEntry[],
  followup: ManagerReviewFollowup,
  category: string,
  now: Date,
  deps: Pick<ReviewHelperDeps, "nowIso">,
): FollowupLedgerEntry {
  const existing = followups.find((entry) => entry.issueId === followup.issueId);
  return {
    issueId: followup.issueId,
    lastPublicFollowupAt: deps.nowIso(now),
    lastCategory: category,
    requestKind: followup.requestKind,
    status: "awaiting-response",
    requestText: followup.request,
    acceptableAnswerHint: followup.acceptableAnswerHint,
    sourceChannelId: followup.source?.channelId,
    sourceThreadTs: followup.source?.rootThreadTs,
    sourceMessageTs: followup.source?.sourceMessageTs,
    assigneeDisplayName: followup.assigneeDisplayName,
    rePingCount: existing?.status === "awaiting-response" ? (existing.rePingCount ?? 0) + 1 : 0,
    resolvedAt: undefined,
    resolvedReason: undefined,
    lastResponseAt: existing?.status === "awaiting-response" ? existing.lastResponseAt : undefined,
    lastResponseKind: existing?.status === "awaiting-response" ? existing.lastResponseKind : undefined,
    lastResponseText: existing?.status === "awaiting-response" ? existing.lastResponseText : undefined,
    resolutionAssessment: existing?.status === "awaiting-response" ? existing.resolutionAssessment : undefined,
  };
}

export function shouldSuppressFollowup(
  followups: FollowupLedgerEntry[],
  issueId: string,
  category: string,
  cooldownHours: number,
  now = new Date(),
): boolean {
  const existing = followups.find((entry) => entry.issueId === issueId && entry.lastCategory === category);
  if (!existing?.lastPublicFollowupAt) return false;
  const elapsedMs = now.getTime() - Date.parse(existing.lastPublicFollowupAt);
  return elapsedMs < cooldownHours * 60 * 60 * 1000;
}

export function selectReviewFollowupItem(
  items: RiskAssessment[],
  followups: FollowupLedgerEntry[],
  policy: ManagerPolicy,
  now: Date,
): RiskAssessment | undefined {
  if (policy.reviewExplicitFollowupCount <= 0) {
    return undefined;
  }

  const eligible = items.filter((item) => !shouldSuppressFollowup(
    followups,
    item.issue.identifier,
    getPrimaryRiskCategory(item),
    policy.followupCooldownHours,
    now,
  ));
  const awaitingIssueIds = new Set(
    followups
      .filter((entry) => entry.status === "awaiting-response")
      .map((entry) => entry.issueId),
  );
  return eligible.find((item) => awaitingIssueIds.has(item.issue.identifier)) ?? eligible[0];
}

export function sortRiskyIssues(items: RiskAssessment[]): RiskAssessment[] {
  const rank: Record<string, number> = {
    overdue: 0,
    due_today: 1,
    blocked: 2,
    stale: 3,
    due_soon: 4,
    owner_missing: 5,
    due_missing: 6,
  };

  return [...items].sort((left, right) => {
    const leftRank = Math.min(...left.riskCategories.map((category) => rank[category] ?? 99));
    const rightRank = Math.min(...right.riskCategories.map((category) => rank[category] ?? 99));
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (right.issue.priority ?? 0) - (left.issue.priority ?? 0);
  });
}

export function isWithinBusinessHours(
  policy: ManagerPolicy,
  now = new Date(),
  deps: Pick<ReviewHelperDeps, "toJstDate">,
): boolean {
  const jst = deps.toJstDate(now);
  const weekday = jst.getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  if (!policy.businessHours.weekdays.includes(isoWeekday)) return false;

  const current = `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
  return current >= policy.businessHours.start && current <= policy.businessHours.end;
}

export function isUrgentRisk(item: RiskAssessment, policy: ManagerPolicy): boolean {
  if (item.riskCategories.includes("overdue") || item.riskCategories.includes("due_today")) {
    return true;
  }
  if (item.riskCategories.includes("blocked")) {
    return true;
  }
  if (
    item.riskCategories.includes("stale")
    && (item.issue.priority ?? 0) > 0
    && (item.issue.priority ?? 99) <= policy.urgentPriorityThreshold
  ) {
    return true;
  }
  return false;
}

export function formatRiskLine(item: RiskAssessment): string {
  const categories = item.riskCategories.join(", ");
  const assignee = item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? "未割当";
  const due = item.issue.dueDate ?? "期限未設定";
  const priority = item.issue.priorityLabel ? ` / 優先度: ${item.issue.priorityLabel}` : "";
  const cycle = item.issue.cycle?.name
    ? ` / Cycle: ${item.issue.cycle.name}`
    : item.issue.cycle?.number != null
      ? ` / Cycle: ${item.issue.cycle.number}`
      : "";
  return `- ${item.issue.identifier} / ${item.issue.title} / ${categories} / 担当: ${assignee} / 期限: ${due}${priority}${cycle}`;
}

export function buildIssueRiskSummary(item: RiskAssessment): string {
  const parts = [item.riskCategories.join(", ")];
  if (item.issue.priorityLabel) {
    parts.push(`優先度: ${item.issue.priorityLabel}`);
  }
  if (item.issue.cycle?.name) {
    parts.push(`Cycle: ${item.issue.cycle.name}`);
  } else if (item.issue.cycle?.number != null) {
    parts.push(`Cycle: ${item.issue.cycle.number}`);
  }
  return parts.join(" / ");
}

export function upsertFollowup(
  followups: FollowupLedgerEntry[],
  patch: FollowupLedgerEntry,
): FollowupLedgerEntry[] {
  const index = followups.findIndex((entry) => entry.issueId === patch.issueId);
  if (index === -1) {
    return [...followups, patch];
  }
  const next = [...followups];
  next[index] = {
    ...next[index],
    ...patch,
  };
  return next;
}

function truncateSlackText(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function formatIssueLineForSlack(issue: ManagerReviewIssueLine): string {
  const title = truncateSlackText(issue.title);
  const assignee = issue.assigneeDisplayName ?? "未割当";
  const issueLabel = issue.issueUrl ? `<${issue.issueUrl}|${issue.issueId}>` : issue.issueId;
  return `- ${issueLabel} | ${title} | ${assignee} | ${issue.riskSummary}`;
}

function formatSlackAssigneeLabel(followup: ManagerReviewFollowup): string {
  if (followup.shouldMention && followup.slackUserId) {
    return `<@${followup.slackUserId}>`;
  }
  return followup.assigneeDisplayName ?? "未割当";
}

export function formatControlRoomFollowupForSlack(
  followup: ManagerReviewFollowup,
  threadReference: string,
): string {
  const answerFormat = followup.acceptableAnswerHint ?? acceptableAnswerHintForRequestKind(followup.requestKind);
  const issueLabel = followup.issueUrl ? `<${followup.issueUrl}|${followup.issueId}>` : followup.issueId;
  return [
    "要返信:",
    issueLabel,
    formatSlackAssigneeLabel(followup),
    followup.request,
    `返答フォーマット: ${answerFormat}`,
    `戻る thread: ${threadReference}`,
  ].join(" | ");
}

export function formatManagerReviewFollowupLine(
  followup: ManagerReviewFollowup,
  threadReference: string,
): string {
  return formatControlRoomFollowupForSlack(followup, threadReference);
}

export function formatControlRoomReviewForSlack(
  result: ManagerReviewResult,
  threadReference?: string,
): string {
  const lines: string[] = [];

  if (result.kind === "morning-review") {
    lines.push("朝の execution review");
  } else if (result.kind === "evening-review") {
    lines.push("夕方の execution review");
  } else if (result.kind === "weekly-review") {
    lines.push("週次 planning review");
  } else {
    lines.push("緊急フォロー");
  }

  for (const summary of result.summaryLines ?? []) {
    lines.push(summary.startsWith("- ") ? summary : `- ${summary}`);
  }
  for (const issueLine of (result.issueLines ?? []).slice(0, 3)) {
    lines.push(formatIssueLineForSlack(issueLine));
  }
  if (result.followup) {
    lines.push("", formatControlRoomFollowupForSlack(result.followup, threadReference ?? "source thread unavailable"));
  }

  if (lines.length === 1) {
    return result.text;
  }
  const [headline, ...rest] = lines;
  return [headline, "", ...rest].join("\n");
}
