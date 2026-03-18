import type { AppConfig } from "../../lib/config.js";
import {
  addLinearComment,
  addLinearProgressComment,
  getLinearIssue,
  updateManagedLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
} from "../../lib/linear.js";
import type { FollowupLedgerEntry } from "../../lib/manager-state.js";
import {
  runFollowupResolutionTurn,
  type FollowupResolutionResult,
} from "../../lib/pi-session.js";
import { issueMatchesCompletedState } from "../review/risk.js";
import { buildThreadPaths } from "../../lib/thread-workspace.js";

export interface FollowupStateMessage {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  text: string;
}

export type FollowupResponseKind = "progress" | "completed" | "blocked" | "followup-response";

function nowIso(now: Date): string {
  return now.toISOString();
}

function resolveFollowupEntry(
  entry: FollowupLedgerEntry,
  now: Date,
  reason: "response" | "risk-cleared" | "completed" | "answered",
): FollowupLedgerEntry {
  return {
    ...entry,
    status: "resolved",
    resolvedAt: nowIso(now),
    resolvedReason: reason,
  };
}

function issueNeedsFollowupResponse(
  followups: FollowupLedgerEntry[],
  issueId: string,
): FollowupLedgerEntry | undefined {
  return followups.find((entry) => entry.issueId === issueId && entry.status === "awaiting-response");
}

function buildFollowupResponseComment(
  message: FollowupStateMessage,
  followup: FollowupLedgerEntry,
): string {
  return [
    "## Follow-up response",
    `- requestKind: ${followup.requestKind ?? "status"}`,
    `- requestText: ${followup.requestText ?? "(none)"}`,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}

export function findAwaitingFollowupCandidates(
  followups: FollowupLedgerEntry[],
  message: FollowupStateMessage,
  controlRoomChannelId: string | undefined,
  extractIssueIdentifiers: (text: string) => string[],
): FollowupLedgerEntry[] {
  const explicitIssueIds = new Set(extractIssueIdentifiers(message.text));
  return followups.filter((entry) => {
    if (entry.status !== "awaiting-response") return false;
    if (entry.sourceChannelId === message.channelId && entry.sourceThreadTs === message.rootThreadTs) return true;
    if (controlRoomChannelId && message.channelId === controlRoomChannelId && explicitIssueIds.has(entry.issueId)) {
      return true;
    }
    return false;
  });
}

export function updateFollowupsWithIssueResponse(
  followups: FollowupLedgerEntry[],
  issues: LinearIssue[],
  kind: FollowupResponseKind,
  responseText: string,
  now: Date,
): FollowupLedgerEntry[] {
  const issueById = new Map(issues.map((issue) => [issue.identifier, issue]));
  return followups.map((entry) => {
    const issue = issueById.get(entry.issueId);
    if (!issue || entry.status === "resolved") {
      return entry;
    }

    const next: FollowupLedgerEntry = {
      ...entry,
      lastResponseAt: nowIso(now),
      lastResponseKind: kind,
      lastResponseText: responseText.trim() || entry.lastResponseText,
    };

    if (issueMatchesCompletedState(issue)) {
      return resolveFollowupEntry(next, now, "completed");
    }

    return next;
  });
}

export async function assessFollowupResponses(
  config: AppConfig,
  message: FollowupStateMessage,
  followups: FollowupLedgerEntry[],
  issues: LinearIssue[],
  paths: ReturnType<typeof buildThreadPaths>,
  now: Date,
): Promise<FollowupLedgerEntry[]> {
  let nextFollowups = [...followups];

  for (const issue of issues) {
    const entry = issueNeedsFollowupResponse(nextFollowups, issue.identifier);
    if (!entry?.requestText || !entry.requestKind) continue;

    if (issueMatchesCompletedState(issue)) {
      nextFollowups = nextFollowups.map((candidate) => candidate.issueId === issue.identifier
        ? resolveFollowupEntry(candidate, now, "completed")
        : candidate);
      continue;
    }

    const assessment = await runFollowupResolutionTurn(
      config,
      paths,
      {
        issueId: issue.identifier,
        issueTitle: issue.title,
        requestKind: entry.requestKind,
        requestText: entry.requestText,
        acceptableAnswerHint: entry.acceptableAnswerHint,
        responseText: message.text,
        taskKey: `${issue.identifier}-${entry.requestKind}`,
      },
    ).catch<FollowupResolutionResult>(() => ({
      answered: false,
      confidence: 0,
      reasoningSummary: "follow-up resolution failed",
    }));

    nextFollowups = nextFollowups.map((candidate) => {
      if (candidate.issueId !== issue.identifier || candidate.status === "resolved") return candidate;
      const patched: FollowupLedgerEntry = {
        ...candidate,
        resolutionAssessment: {
          answered: assessment.answered,
          answerKind: assessment.answerKind,
          confidence: assessment.confidence,
          extractedFields: assessment.extractedFields,
        },
      };

      if (assessment.answered && assessment.confidence >= 0.7) {
        return resolveFollowupEntry(patched, now, "answered");
      }
      return patched;
    });
  }

  return nextFollowups;
}

export async function applyFollowupExtractedFields(
  followup: FollowupLedgerEntry,
  issue: LinearIssue,
  assessment: FollowupResolutionResult,
  message: FollowupStateMessage,
  env: LinearCommandEnv,
): Promise<LinearIssue> {
  const extracted = assessment.extractedFields ?? {};
  if (followup.requestKind === "owner" && extracted.assignee) {
    return updateManagedLinearIssue(
      {
        issueId: issue.identifier,
        assignee: extracted.assignee,
      },
      env,
    );
  }

  if (followup.requestKind === "due-date" && extracted.dueDate) {
    return updateManagedLinearIssue(
      {
        issueId: issue.identifier,
        dueDate: extracted.dueDate,
      },
      env,
    );
  }

  if (followup.requestKind === "status") {
    await addLinearProgressComment(issue.identifier, buildFollowupResponseComment(message, followup), env);
    return getLinearIssue(issue.identifier, env, undefined, { includeComments: true });
  }

  await addLinearComment(issue.identifier, buildFollowupResponseComment(message, followup), env);
  return getLinearIssue(issue.identifier, env, undefined, { includeComments: true });
}

export function applyFollowupAssessmentResult(
  followups: FollowupLedgerEntry[],
  issueId: string,
  assessment: FollowupResolutionResult,
  now: Date,
  reason: "answered" | "risk-cleared" | "completed" | undefined,
): FollowupLedgerEntry[] {
  return followups.map((entry) => {
    if (entry.issueId !== issueId) return entry;
    const patched: FollowupLedgerEntry = {
      ...entry,
      resolutionAssessment: {
        answered: assessment.answered,
        answerKind: assessment.answerKind,
        confidence: assessment.confidence,
        extractedFields: assessment.extractedFields,
      },
    };

    if (reason) {
      return resolveFollowupEntry(patched, now, reason);
    }
    return patched;
  });
}
