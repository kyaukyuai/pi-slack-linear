import type { AppConfig } from "../../lib/config.js";
import { listRiskyLinearIssues } from "../../lib/linear.js";
import {
  loadFollowupsLedger,
  loadIntakeLedger,
  loadManagerPolicy,
  loadOwnerMap,
  loadPlanningLedger,
  saveFollowupsLedger,
  type FollowupLedgerEntry,
  type IntakeLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type PlanningLedgerEntry,
} from "../../lib/manager-state.js";
import type { SystemPaths } from "../../lib/system-workspace.js";
import type { RiskAssessment } from "./contract.js";
import { assessRisk, issueMatchesCompletedState } from "./risk.js";

export interface ManagerReviewData {
  policy: ManagerPolicy;
  ownerMap: OwnerMap;
  followups: FollowupLedgerEntry[];
  planningLedger: PlanningLedgerEntry[];
  intakeLedger: IntakeLedgerEntry[];
  risky: RiskAssessment[];
}

function resolveFollowupEntry(
  entry: FollowupLedgerEntry,
  now: Date,
  reason: "response" | "risk-cleared" | "completed" | "answered",
): FollowupLedgerEntry {
  return {
    ...entry,
    status: "resolved",
    resolvedAt: now.toISOString(),
    resolvedReason: reason,
  };
}

function reconcileFollowupsWithRiskyIssues(
  followups: FollowupLedgerEntry[],
  risky: RiskAssessment[],
  now: Date,
): { changed: boolean; followups: FollowupLedgerEntry[] } {
  const riskyByIssueId = new Map(risky.map((item) => [item.issue.identifier, item]));
  let changed = false;
  const next = followups.map((entry) => {
    if (entry.status !== "awaiting-response") {
      return entry;
    }

    const current = riskyByIssueId.get(entry.issueId);
    if (!current) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (issueMatchesCompletedState(current.issue)) {
      changed = true;
      return resolveFollowupEntry(entry, now, "completed");
    }

    if (entry.lastCategory === "owner_missing" && !current.ownerMissing) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (entry.lastCategory === "due_missing" && !current.dueMissing) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (entry.lastCategory === "blocked" && !current.blocked) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    return entry;
  });

  return { changed, followups: next };
}

export async function loadManagerReviewData(
  config: AppConfig,
  systemPaths: SystemPaths,
  now: Date,
): Promise<ManagerReviewData> {
  const policy = await loadManagerPolicy(systemPaths);
  const ownerMap = await loadOwnerMap(systemPaths);
  const followups = await loadFollowupsLedger(systemPaths);
  const planningLedger = await loadPlanningLedger(systemPaths);
  const intakeLedger = await loadIntakeLedger(systemPaths);
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  const risky = (await listRiskyLinearIssues(
    {
      staleBusinessDays: policy.staleBusinessDays,
      urgentPriorityThreshold: policy.urgentPriorityThreshold,
    },
    env,
  )).map((issue) => assessRisk(issue, policy, now)).filter((item) => item.riskCategories.length > 0);

  const reconciled = reconcileFollowupsWithRiskyIssues(followups, risky, now);
  if (reconciled.changed) {
    await saveFollowupsLedger(systemPaths, reconciled.followups);
  }

  return {
    policy,
    ownerMap,
    followups: reconciled.followups,
    planningLedger,
    intakeLedger,
    risky,
  };
}
