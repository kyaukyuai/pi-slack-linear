import type { AppConfig } from "../../lib/config.js";
import {
  type FollowupLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type PlanningLedgerEntry,
} from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import { recordFollowupTransitions } from "../../state/workgraph/recorder.js";
import type {
  HeartbeatReviewDecision,
  ManagerReviewFollowup,
  ManagerReviewResult,
  ManagerReviewKind,
  RiskAssessment,
} from "./contract.js";
import type { ManagerReviewData } from "./review-data.js";

export interface ReviewHelpers {
  loadManagerReviewData(
    config: AppConfig,
    repositories: Pick<ManagerRepositories, "policy" | "ownerMap" | "followups" | "planning" | "workgraph">,
    now: Date,
  ): Promise<ManagerReviewData>;
  isWithinBusinessHours(policy: ManagerPolicy, now: Date): boolean;
  sortRiskyIssues(risky: RiskAssessment[]): RiskAssessment[];
  isUrgentRisk(item: RiskAssessment, policy: ManagerPolicy): boolean;
  shouldSuppressFollowup(
    followups: FollowupLedgerEntry[],
    issueId: string,
    category: string,
    cooldownHours: number,
    now: Date,
  ): boolean;
  buildReviewFollowup(
    item: RiskAssessment,
    ownerMap: OwnerMap,
    existingFollowup: FollowupLedgerEntry | undefined,
    issueSources: ManagerReviewData["issueSources"],
  ): ManagerReviewFollowup;
  upsertFollowup(
    followups: FollowupLedgerEntry[],
    patch: FollowupLedgerEntry,
  ): FollowupLedgerEntry[];
  buildAwaitingFollowupPatch(
    followups: FollowupLedgerEntry[],
    followup: ManagerReviewFollowup,
    category: string,
    now: Date,
  ): FollowupLedgerEntry;
  getPrimaryRiskCategory(item: RiskAssessment): string;
  buildIssueRiskSummary(item: RiskAssessment): string;
  formatRiskLine(item: RiskAssessment): string;
  selectReviewFollowupItem(
    items: RiskAssessment[],
    followups: FollowupLedgerEntry[],
    policy: ManagerPolicy,
    now: Date,
  ): RiskAssessment | undefined;
}

export interface BuildHeartbeatReviewDecisionArgs {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "followups" | "policy" | "ownerMap" | "planning" | "workgraph">;
  now: Date;
  helpers: ReviewHelpers;
}

export interface BuildManagerReviewArgs extends BuildHeartbeatReviewDecisionArgs {
  kind: ManagerReviewKind;
}

export async function buildHeartbeatReviewDecision({
  config,
  repositories,
  now,
  helpers,
}: BuildHeartbeatReviewDecisionArgs): Promise<HeartbeatReviewDecision> {
  const { policy, ownerMap, followups, issueSources, risky } = await helpers.loadManagerReviewData(
    config,
    repositories,
    now,
  );

  if (!helpers.isWithinBusinessHours(policy, now)) {
    return { reason: "outside-business-hours" };
  }

  const urgent = helpers.sortRiskyIssues(risky).filter((item) => helpers.isUrgentRisk(item, policy));
  if (urgent.length === 0) {
    return { reason: "no-urgent-items" };
  }

  const available = urgent.filter((item) => !helpers.shouldSuppressFollowup(
    followups,
    item.issue.identifier,
    helpers.getPrimaryRiskCategory(item),
    policy.followupCooldownHours,
    now,
  ));

  if (available.length === 0) {
    return { reason: "suppressed-by-cooldown" };
  }

  const top = available[0];
  const existingFollowup = followups.find((entry) => entry.issueId === top.issue.identifier);
  const followup = helpers.buildReviewFollowup(top, ownerMap, existingFollowup, issueSources);
  const nextFollowups = helpers.upsertFollowup(
    followups,
    helpers.buildAwaitingFollowupPatch(
      followups,
      followup,
      helpers.getPrimaryRiskCategory(top),
      now,
    ),
  );
  await repositories.followups.save(nextFollowups);
  await recordFollowupTransitions(repositories.workgraph, followups, nextFollowups, {
    occurredAt: now.toISOString(),
    reviewKind: "heartbeat",
    source: followup.source
      ? {
          channelId: followup.source.channelId,
          rootThreadTs: followup.source.rootThreadTs,
          messageTs: followup.source.sourceMessageTs,
        }
      : undefined,
  });

  return {
    review: {
      kind: "heartbeat",
      text: [
        "緊急フォローが必要です。",
        helpers.formatRiskLine(top),
      ].join("\n"),
      summaryLines: ["blocked / overdue / due today の優先確認が必要です。"],
      issueLines: [{
        issueId: top.issue.identifier,
        title: top.issue.title,
        assigneeDisplayName: top.issue.assignee?.displayName ?? top.issue.assignee?.name ?? undefined,
        riskSummary: helpers.buildIssueRiskSummary(top),
      }],
      followup,
    },
  };
}

export async function buildManagerReview({
  config,
  repositories,
  kind,
  now,
  helpers,
}: BuildManagerReviewArgs): Promise<ManagerReviewResult | undefined> {
  if (kind === "heartbeat") {
    const decision = await buildHeartbeatReviewDecision({
      config,
      repositories,
      now,
      helpers,
    });
    return decision.review;
  }

  const {
    policy,
    ownerMap,
    followups,
    planningLedger,
    awaitingFollowupCount,
    issueSources,
    pendingClarificationCount,
    risky,
  } = await helpers.loadManagerReviewData(
    config,
    repositories,
    now,
  );

  const sorted = helpers.sortRiskyIssues(risky);
  if (kind === "morning-review") {
    const lines = ["朝の execution review です。"];
    const items = sorted.filter((item) => !item.riskCategories.includes("due_missing")).slice(0, 3);
    if (items.length === 0) {
      return {
        kind,
        text: "朝の execution review です。\n- 今日すぐに共有すべきリスクはありません。",
        summaryLines: ["今日すぐに共有すべきリスクはありません。"],
      };
    }
    lines.push("今日やるべきこと / 期限リスク / stale:");
    for (const item of items) lines.push(helpers.formatRiskLine(item));
    const followupItem = helpers.selectReviewFollowupItem(items, followups, policy, now);
    let followup: ManagerReviewFollowup | undefined;
    if (followupItem) {
      const existingFollowup = followups.find((entry) => entry.issueId === followupItem.issue.identifier);
      followup = helpers.buildReviewFollowup(followupItem, ownerMap, existingFollowup, issueSources);
      const nextFollowups = helpers.upsertFollowup(
        followups,
        helpers.buildAwaitingFollowupPatch(
          followups,
          followup,
          helpers.getPrimaryRiskCategory(followupItem),
          now,
        ),
      );
      await repositories.followups.save(nextFollowups);
      await recordFollowupTransitions(repositories.workgraph, followups, nextFollowups, {
        occurredAt: now.toISOString(),
        reviewKind: kind,
        source: followup.source
          ? {
              channelId: followup.source.channelId,
              rootThreadTs: followup.source.rootThreadTs,
              messageTs: followup.source.sourceMessageTs,
            }
          : undefined,
      });
    }
    return {
      kind,
      text: lines.join("\n"),
      summaryLines: ["今日やるべきこと / 期限リスク / stale"],
      issueLines: items.map((item) => ({
        issueId: item.issue.identifier,
        title: item.issue.title,
        issueUrl: item.issue.url,
        assigneeDisplayName: item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? undefined,
        riskSummary: helpers.buildIssueRiskSummary(item),
      })),
      followup,
    };
  }

  if (kind === "evening-review") {
    const lines = ["夕方の進捗 review です。"];
    const items = sorted
      .filter((item) => item.riskCategories.some((category) => ["due_today", "blocked", "overdue", "stale"].includes(category)))
      .slice(0, 3);
    if (items.length === 0) {
      return {
        kind,
        text: "夕方の進捗 review です。\n- 今日の残タスクで強いリスクは見当たりません。",
        summaryLines: ["今日の残タスクで強いリスクは見当たりません。"],
      };
    }
    lines.push("今日残っていること / blocked / due today:");
    for (const item of items) lines.push(helpers.formatRiskLine(item));
    const followupItem = helpers.selectReviewFollowupItem(items, followups, policy, now);
    let followup: ManagerReviewFollowup | undefined;
    if (followupItem) {
      const existingFollowup = followups.find((entry) => entry.issueId === followupItem.issue.identifier);
      followup = helpers.buildReviewFollowup(followupItem, ownerMap, existingFollowup, issueSources);
      const nextFollowups = helpers.upsertFollowup(
        followups,
        helpers.buildAwaitingFollowupPatch(
          followups,
          followup,
          helpers.getPrimaryRiskCategory(followupItem),
          now,
        ),
      );
      await repositories.followups.save(nextFollowups);
      await recordFollowupTransitions(repositories.workgraph, followups, nextFollowups, {
        occurredAt: now.toISOString(),
        reviewKind: kind,
        source: followup.source
          ? {
              channelId: followup.source.channelId,
              rootThreadTs: followup.source.rootThreadTs,
              messageTs: followup.source.sourceMessageTs,
            }
          : undefined,
      });
    }
    return {
      kind,
      text: lines.join("\n"),
      summaryLines: ["残タスク / blocked / due today"],
      issueLines: items.map((item) => ({
        issueId: item.issue.identifier,
        title: item.issue.title,
        issueUrl: item.issue.url,
        assigneeDisplayName: item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? undefined,
        riskSummary: helpers.buildIssueRiskSummary(item),
      })),
      followup,
    };
  }

  const fallbackCount = planningLedger.filter((entry) => entry.ownerResolution === "fallback").length;
  const staleItems = sorted.filter((item) => item.riskCategories.includes("stale")).slice(0, 5);
  const lines = ["週次 planning review です。"];
  lines.push(`- 未整備 issue: ${sorted.filter((item) => item.ownerMissing || item.dueMissing).length}`);
  lines.push(`- 長期 stale: ${staleItems.length}`);
  lines.push(`- owner map gap: ${fallbackCount}`);
  lines.push(`- 未回答 follow-up: ${awaitingFollowupCount}`);
  lines.push(`- 未処理 clarification: ${pendingClarificationCount}`);
  for (const item of staleItems.slice(0, 3)) {
    lines.push(helpers.formatRiskLine(item));
  }
  const weeklyItems = staleItems.slice(0, 3);
  const followupItem = helpers.selectReviewFollowupItem(weeklyItems, followups, policy, now);
  let followup: ManagerReviewFollowup | undefined;
  if (followupItem) {
    const existingFollowup = followups.find((entry) => entry.issueId === followupItem.issue.identifier);
    followup = helpers.buildReviewFollowup(followupItem, ownerMap, existingFollowup, issueSources);
    const nextFollowups = helpers.upsertFollowup(
      followups,
      helpers.buildAwaitingFollowupPatch(
        followups,
        followup,
        helpers.getPrimaryRiskCategory(followupItem),
        now,
      ),
    );
    await repositories.followups.save(nextFollowups);
    await recordFollowupTransitions(repositories.workgraph, followups, nextFollowups, {
      occurredAt: now.toISOString(),
      reviewKind: kind,
      source: followup.source
        ? {
            channelId: followup.source.channelId,
            rootThreadTs: followup.source.rootThreadTs,
            messageTs: followup.source.sourceMessageTs,
          }
        : undefined,
    });
  }
  return {
    kind,
    text: lines.join("\n"),
    summaryLines: [
      `未整備 issue: ${sorted.filter((item) => item.ownerMissing || item.dueMissing).length}`,
      `長期 stale: ${staleItems.length}`,
      `owner map gap: ${fallbackCount}`,
      `未回答 follow-up: ${awaitingFollowupCount}`,
      `未処理 clarification: ${pendingClarificationCount}`,
    ],
    issueLines: weeklyItems.map((item) => ({
      issueId: item.issue.identifier,
      title: item.issue.title,
      issueUrl: item.issue.url,
      assigneeDisplayName: item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? undefined,
      riskSummary: helpers.buildIssueRiskSummary(item),
    })),
    followup,
  };
}
