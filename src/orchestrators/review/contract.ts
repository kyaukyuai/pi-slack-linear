import type { LinearIssue } from "../../lib/linear.js";

export type ManagerReviewKind = "morning-review" | "evening-review" | "weekly-review" | "heartbeat";

export interface ManagerFollowupSource {
  channelId: string;
  rootThreadTs: string;
  sourceMessageTs: string;
}

export interface ManagerReviewFollowup {
  issueId: string;
  issueTitle: string;
  issueUrl?: string | null;
  request: string;
  requestKind: "status" | "blocked-details" | "owner" | "due-date";
  acceptableAnswerHint?: string;
  assigneeDisplayName?: string;
  slackUserId?: string;
  riskCategory: string;
  shouldMention: boolean;
  source?: ManagerFollowupSource;
}

export interface ManagerReviewIssueLine {
  issueId: string;
  title: string;
  issueUrl?: string | null;
  assigneeDisplayName?: string;
  riskSummary: string;
}

export interface ManagerReviewResult {
  kind: ManagerReviewKind;
  text: string;
  summaryLines?: string[];
  issueLines?: ManagerReviewIssueLine[];
  followup?: ManagerReviewFollowup;
}

export type HeartbeatNoopReason =
  | "outside-business-hours"
  | "no-active-channels"
  | "no-urgent-items"
  | "suppressed-by-cooldown";

export interface HeartbeatReviewDecision {
  review?: ManagerReviewResult;
  reason?: HeartbeatNoopReason;
}

export interface RiskAssessment {
  issue: LinearIssue;
  riskCategories: string[];
  ownerMissing: boolean;
  dueMissing: boolean;
  blocked: boolean;
  businessDaysSinceUpdate: number;
}
