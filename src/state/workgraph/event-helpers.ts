import type { FollowupLedgerEntry } from "../manager-state-contract.js";
import {
  buildWorkgraphThreadKey,
  createWorkgraphEvent,
  type WorkgraphEvent,
} from "./events.js";

export interface ThreadScopedWorkgraphSource {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
}

export interface WorkgraphFollowupContext {
  occurredAt: string;
  reviewKind?: "heartbeat" | "morning-review" | "evening-review" | "weekly-review";
  source?: ThreadScopedWorkgraphSource;
}

export function buildThreadScopedWorkgraphFields(source: ThreadScopedWorkgraphSource): {
  threadKey: string;
  sourceChannelId: string;
  sourceThreadTs: string;
  sourceMessageTs: string;
} {
  return {
    threadKey: buildWorkgraphThreadKey(source.channelId, source.rootThreadTs),
    sourceChannelId: source.channelId,
    sourceThreadTs: source.rootThreadTs,
    sourceMessageTs: source.messageTs,
  };
}

export function collectFollowupTransitionEvents(
  previous: FollowupLedgerEntry[],
  current: FollowupLedgerEntry[],
  context: WorkgraphFollowupContext,
): WorkgraphEvent[] {
  const previousByIssueId = new Map(previous.map((entry) => [entry.issueId, entry]));
  const sourceFields = context.source ? buildThreadScopedWorkgraphFields(context.source) : {};

  return current.flatMap((entry) => {
    const prior = previousByIssueId.get(entry.issueId);
    if (entry.status === "awaiting-response" && prior?.status !== "awaiting-response") {
      return [createWorkgraphEvent({
        type: "followup.requested",
        occurredAt: context.occurredAt,
        issueId: entry.issueId,
        category: entry.lastCategory ?? "review",
        requestKind: entry.requestKind,
        requestText: entry.requestText,
        reviewKind: context.reviewKind,
        ...sourceFields,
      })];
    }

    if (entry.status === "resolved" && prior?.status !== "resolved" && entry.resolvedReason) {
      return [createWorkgraphEvent({
        type: "followup.resolved",
        occurredAt: entry.resolvedAt ?? context.occurredAt,
        issueId: entry.issueId,
        reason: entry.resolvedReason,
        responseKind: entry.lastResponseKind,
        textSnippet: entry.lastResponseText,
        ...sourceFields,
      })];
    }

    return [];
  });
}
