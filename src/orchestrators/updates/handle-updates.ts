import type { AppConfig } from "../../lib/config.js";
import {
  addLinearComment,
  addLinearProgressComment,
  getLinearIssue,
  markLinearIssueBlocked,
  updateLinearIssueState,
  type LinearCommandEnv,
  type LinearIssue,
} from "../../lib/linear.js";
import {
  type FollowupLedgerEntry,
  type ManagerPolicy,
} from "../../state/manager-state-contract.js";
import {
  runFollowupResolutionTurn,
  type FollowupResolutionResult,
} from "../../lib/pi-session.js";
import { buildThreadPaths } from "../../lib/thread-workspace.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import {
  recordFollowupTransitions,
  recordIssueSignals,
} from "../../state/workgraph/recorder.js";
import { issueMatchesCompletedState } from "../review/risk.js";
import {
  applyFollowupAssessmentResult,
  applyFollowupExtractedFields,
  assessFollowupResponses,
  findAwaitingFollowupCandidates,
  updateFollowupsWithIssueResponse,
} from "./followup-state.js";
import {
  extractIssueIdentifiers,
  formatIssueSelectionReply,
  resolveIssueTargetsFromThread,
} from "./target-resolution.js";
import {
  formatFollowupResolutionReply,
  formatStatusReply,
} from "./reply-format.js";

export type UpdateSignal = "progress" | "completed" | "blocked";
export type ManagerSignal = UpdateSignal | "request" | "query" | "conversation";

export interface UpdatesMessage {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId: string;
  text: string;
}

export interface UpdatesHandleResult {
  handled: boolean;
  reply?: string;
}

export interface UpdatesHelpers {
  formatReviewFollowupPrompt(item: unknown): string;
  assessRisk(issue: LinearIssue, policy: ManagerPolicy, now: Date): unknown;
  nowIso(now: Date): string;
}

export interface HandleManagerUpdatesArgs {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "followups" | "workgraph">;
  message: UpdatesMessage;
  now: Date;
  signal: ManagerSignal;
  policy: ManagerPolicy;
  followups: FollowupLedgerEntry[];
  allowFollowupResolution: boolean;
  env: LinearCommandEnv;
  helpers: UpdatesHelpers;
}

export async function handleManagerUpdates({
  config,
  repositories,
  message,
  now,
  signal,
  policy,
  followups,
  allowFollowupResolution,
  env,
  helpers,
}: HandleManagerUpdatesArgs): Promise<UpdatesHandleResult | undefined> {
  const occurredAt = helpers.nowIso(now);
  const workgraphSource = {
    channelId: message.channelId,
    rootThreadTs: message.rootThreadTs,
    messageTs: message.messageTs,
  };

  if (allowFollowupResolution) {
    const awaitingFollowups = findAwaitingFollowupCandidates(
      followups,
      message,
      policy.controlRoomChannelId,
      extractIssueIdentifiers,
    );
    if (awaitingFollowups.length > 0) {
      let selectedFollowup = awaitingFollowups.length === 1 ? awaitingFollowups[0] : undefined;

      if (!selectedFollowup) {
        const explicitIssueIds = extractIssueIdentifiers(message.text);
        if (explicitIssueIds.length === 1) {
          selectedFollowup = awaitingFollowups.find((entry) => entry.issueId === explicitIssueIds[0]);
        }
      }

      if (!selectedFollowup) {
        return {
          handled: true,
          reply: formatIssueSelectionReply(
            "progress",
            awaitingFollowups.map((entry) => ({
              issueId: entry.issueId,
              title: undefined,
            })),
          ),
        };
      }

      const issue = await getLinearIssue(selectedFollowup.issueId, env, undefined, { includeComments: true });
      const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
      const assessment = await runFollowupResolutionTurn(
        config,
        paths,
        {
          issueId: issue.identifier,
          issueTitle: issue.title,
          requestKind: selectedFollowup.requestKind ?? "status",
          requestText: selectedFollowup.requestText ?? helpers.formatReviewFollowupPrompt(
            helpers.assessRisk(issue, policy, now),
          ),
          acceptableAnswerHint: selectedFollowup.acceptableAnswerHint,
          responseText: message.text,
          taskKey: `${issue.identifier}-followup`,
        },
      ).catch<FollowupResolutionResult>(() => ({
        answered: false,
        confidence: 0,
        reasoningSummary: "follow-up resolution failed",
      }));

      let updatedIssue = issue;
      let resolveReason: "answered" | "risk-cleared" | "completed" | undefined;
      if (selectedFollowup.requestKind === "owner" && assessment.extractedFields?.assignee) {
        updatedIssue = await applyFollowupExtractedFields(
          selectedFollowup,
          issue,
          assessment,
          message,
          env,
        );
        resolveReason = updatedIssue.assignee ? "risk-cleared" : undefined;
      } else if (selectedFollowup.requestKind === "due-date" && assessment.extractedFields?.dueDate) {
        updatedIssue = await applyFollowupExtractedFields(
          selectedFollowup,
          issue,
          assessment,
          message,
          env,
        );
        resolveReason = updatedIssue.dueDate ? "risk-cleared" : undefined;
      } else if (
        selectedFollowup.requestKind === "status"
        || selectedFollowup.requestKind === "blocked-details"
        || (assessment.answered && assessment.confidence >= 0.7)
      ) {
        updatedIssue = await applyFollowupExtractedFields(
          selectedFollowup,
          issue,
          assessment,
          message,
          env,
        );
        if (assessment.answered && assessment.confidence >= 0.7) {
          resolveReason = issueMatchesCompletedState(updatedIssue) ? "completed" : "answered";
        }
      }

      let nextFollowups = updateFollowupsWithIssueResponse(
        followups,
        [updatedIssue],
        "followup-response",
        message.text,
        now,
      );
      nextFollowups = applyFollowupAssessmentResult(
        nextFollowups,
        updatedIssue.identifier,
        assessment,
        now,
        resolveReason,
      );
      await repositories.followups.save(nextFollowups);

      await recordFollowupTransitions(repositories.workgraph, followups, nextFollowups, {
        occurredAt,
        source: workgraphSource,
      });

      return {
        handled: true,
        reply: formatFollowupResolutionReply(selectedFollowup, updatedIssue, assessment),
      };
    }
  }

  if (signal === "request" || signal === "query" || signal === "conversation") {
    return undefined;
  }

  if (!policy.autoStatusUpdate) {
    return { handled: false };
  }

  const resolution = await resolveIssueTargetsFromThread(
    message,
    signal,
    config.workspaceDir,
    env,
    repositories.workgraph,
  );
  if (resolution.reason === "missing" || resolution.reason === "ambiguous") {
    return {
      handled: true,
      reply: formatIssueSelectionReply(signal, resolution.candidates),
    };
  }

  const targetIssueIds = resolution.selectedIssueIds;
  const extras: string[] = [];
  const updatedIssues: LinearIssue[] = [];
  const blockedStateByIssueId = new Map<string, boolean>();

  if (signal === "progress") {
    for (const issueId of targetIssueIds) {
      await addLinearProgressComment(issueId, formatStatusSourceComment(message, "## Progress source"), env);
      updatedIssues.push(await getLinearIssue(issueId, env));
    }
  } else if (signal === "completed") {
    for (const issueId of targetIssueIds) {
      updatedIssues.push(await updateLinearIssueState(issueId, "completed", env));
      await addLinearComment(issueId, formatStatusSourceComment(message, "## Completion source"), env);
    }
  } else {
    for (const issueId of targetIssueIds) {
      const result = await markLinearIssueBlocked(issueId, formatStatusSourceComment(message, "## Blocked source"), env);
      updatedIssues.push(result.issue);
      blockedStateByIssueId.set(issueId, result.blockedStateApplied);
      if (!result.blockedStateApplied) {
        extras.push(`${issueId} は workflow に blocked state が無いため、comment のみ追加しました。`);
      }
    }
  }

  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  const followupState = updateFollowupsWithIssueResponse(
    followups,
    updatedIssues,
    signal,
    message.text,
    now,
  );
  const assessedFollowups = await assessFollowupResponses(config, message, followupState, updatedIssues, paths, now);
  await repositories.followups.save(assessedFollowups);
  await recordIssueSignals(repositories.workgraph, {
    occurredAt,
    source: workgraphSource,
    textSnippet: message.text,
    updates: updatedIssues.map((issue) => ({
      issueId: issue.identifier,
      signal,
      blockedStateApplied: blockedStateByIssueId.get(issue.identifier),
    })),
  });
  await recordFollowupTransitions(repositories.workgraph, followups, assessedFollowups, {
    occurredAt,
    source: workgraphSource,
  });

  return {
    handled: true,
    reply: formatStatusReply(signal, updatedIssues, extras),
  };
}

function formatStatusSourceComment(message: UpdatesMessage, heading: string): string {
  return [
    heading,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}
