import type { AppConfig } from "../../lib/config.js";
import type { LinearCommandEnv, LinearIssue } from "../../lib/linear.js";
import type { ThreadQueryContinuation } from "../../lib/query-continuation.js";
import type { ManagerPolicy } from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { RiskAssessment } from "../review/contract.js";

export type ManagerQueryKind =
  | "list-active"
  | "list-today"
  | "what-should-i-do"
  | "inspect-work"
  | "search-existing"
  | "recommend-next-step"
  | "reference-material";

export type ManagerQueryScope = "self" | "team" | "thread-context";

export interface QueryContinuationSnapshot {
  issueIds: string[];
  shownIssueIds: string[];
  remainingIssueIds: string[];
  totalItemCount: number;
  replySummary?: string;
}

export interface QueryHandleResult {
  handled: boolean;
  reply?: string;
  continuation?: QueryContinuationSnapshot;
}

export interface QueryMessage {
  channelId: string;
  rootThreadTs: string;
  userId: string;
  text: string;
}

export interface HandleManagerQueryArgs {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "policy" | "ownerMap" | "workgraph">;
  kind: ManagerQueryKind;
  queryScope: ManagerQueryScope;
  message: QueryMessage;
  now: Date;
  workspaceDir: string;
  env: LinearCommandEnv;
  lastQueryContext?: ThreadQueryContinuation;
}

export interface RankedQueryItem {
  issue: LinearIssue;
  assessment: RiskAssessment;
  score: number;
  viewerOwned: boolean;
}

export interface InspectResolution {
  issueId?: string;
  candidates: Array<{ issueId: string; title?: string; url?: string | null }>;
}

export interface InspectCandidateScore {
  issueId: string;
  title?: string;
  url?: string | null;
  score: number;
}

export interface ViewerQueryOptions {
  viewerAssignee?: string;
  viewerDisplayLabel?: string;
  preferViewerOwned?: boolean;
  viewerMappingMissing?: boolean;
}

export interface QueryPlannerReplyArgs {
  config: AppConfig;
  message: QueryMessage;
  now: Date;
  kind: Exclude<ManagerQueryKind, "reference-material">;
  queryScope: ManagerQueryScope;
  facts: Record<string, unknown>;
  fallbackReply: string;
}

export interface ListQueryReplyArgs extends ViewerQueryOptions {
  policy: ManagerPolicy;
}
