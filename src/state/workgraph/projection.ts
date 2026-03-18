import type { WorkgraphEvent } from "./events.js";

export interface WorkgraphIssueProjection {
  issueId: string;
  title?: string;
  kind?: "parent" | "execution" | "research";
  parentIssueId?: string;
  dueDate?: string;
  assignee?: string;
  threadKeys: string[];
  lastStatus?: "progress" | "completed" | "blocked";
  lastStatusAt?: string;
  followupStatus?: "awaiting-response" | "resolved";
  lastFollowupCategory?: string;
  lastFollowupRequestedAt?: string;
  lastFollowupResolvedAt?: string;
  lastFollowupResolvedReason?: "response" | "risk-cleared" | "completed" | "answered";
}

export interface WorkgraphThreadProjection {
  threadKey: string;
  sourceChannelId?: string;
  sourceThreadTs?: string;
  lastEventAt?: string;
  intakeStatus?: "needs-clarification" | "linked-existing" | "created";
  pendingClarification: boolean;
  parentIssueId?: string;
  childIssueIds: string[];
  linkedIssueIds: string[];
  planningReason?: string;
  lastResolvedIssueId?: string;
  awaitingFollowupIssueIds: string[];
  issueStatuses: Record<string, "progress" | "completed" | "blocked">;
}

export interface WorkgraphProjection {
  issues: Record<string, WorkgraphIssueProjection>;
  threads: Record<string, WorkgraphThreadProjection>;
}

function uniquePush(values: string[], value: string | undefined): void {
  if (!value) return;
  if (!values.includes(value)) {
    values.push(value);
  }
}

function getOrCreateIssue(
  projection: WorkgraphProjection,
  issueId: string,
): WorkgraphIssueProjection {
  if (!projection.issues[issueId]) {
    projection.issues[issueId] = {
      issueId,
      threadKeys: [],
    };
  }
  return projection.issues[issueId];
}

function getOrCreateThread(
  projection: WorkgraphProjection,
  threadKey: string,
): WorkgraphThreadProjection {
  if (!projection.threads[threadKey]) {
    projection.threads[threadKey] = {
      threadKey,
      pendingClarification: false,
      childIssueIds: [],
      linkedIssueIds: [],
      awaitingFollowupIssueIds: [],
      issueStatuses: {},
    };
  }
  return projection.threads[threadKey];
}

export function projectWorkgraph(events: WorkgraphEvent[]): WorkgraphProjection {
  const projection: WorkgraphProjection = {
    issues: {},
    threads: {},
  };

  for (const event of events) {
    const thread = event.threadKey ? getOrCreateThread(projection, event.threadKey) : undefined;
    if (thread) {
      thread.lastEventAt = event.occurredAt;
      thread.sourceChannelId = event.sourceChannelId ?? thread.sourceChannelId;
      thread.sourceThreadTs = event.sourceThreadTs ?? thread.sourceThreadTs;
    }

    switch (event.type) {
      case "intake.clarification_requested":
        if (thread) {
          thread.intakeStatus = "needs-clarification";
          thread.pendingClarification = true;
        }
        break;
      case "intake.linked_existing":
        if (thread) {
          thread.intakeStatus = "linked-existing";
          thread.pendingClarification = false;
          thread.lastResolvedIssueId = event.lastResolvedIssueId ?? thread.lastResolvedIssueId;
          for (const issueId of event.linkedIssueIds) {
            uniquePush(thread.linkedIssueIds, issueId);
            uniquePush(getOrCreateIssue(projection, issueId).threadKeys, event.threadKey);
          }
        }
        break;
      case "intake.created":
        if (thread) {
          thread.intakeStatus = "created";
          thread.pendingClarification = false;
          thread.parentIssueId = event.parentIssueId ?? thread.parentIssueId;
          thread.planningReason = event.planningReason;
          thread.lastResolvedIssueId = event.lastResolvedIssueId ?? thread.lastResolvedIssueId;
          for (const issueId of event.childIssueIds) {
            uniquePush(thread.childIssueIds, issueId);
          }
        }
        if (event.parentIssueId) {
          uniquePush(getOrCreateIssue(projection, event.parentIssueId).threadKeys, event.threadKey);
        }
        for (const issueId of event.childIssueIds) {
          uniquePush(getOrCreateIssue(projection, issueId).threadKeys, event.threadKey);
        }
        break;
      case "planning.parent_created": {
        const issue = getOrCreateIssue(projection, event.issueId);
        issue.kind = "parent";
        issue.title = event.title;
        issue.dueDate = event.dueDate ?? issue.dueDate;
        issue.assignee = event.assignee ?? issue.assignee;
        uniquePush(issue.threadKeys, event.threadKey);
        if (thread) {
          thread.parentIssueId = event.issueId;
        }
        break;
      }
      case "planning.child_created": {
        const issue = getOrCreateIssue(projection, event.issueId);
        issue.kind = event.kind;
        issue.title = event.title;
        issue.parentIssueId = event.parentIssueId ?? issue.parentIssueId;
        issue.dueDate = event.dueDate ?? issue.dueDate;
        issue.assignee = event.assignee ?? issue.assignee;
        uniquePush(issue.threadKeys, event.threadKey);
        if (thread) {
          thread.parentIssueId = event.parentIssueId ?? thread.parentIssueId;
          uniquePush(thread.childIssueIds, event.issueId);
          thread.lastResolvedIssueId = event.issueId;
        }
        break;
      }
      case "planning.recorded":
        if (thread) {
          thread.planningReason = event.planningReason;
          thread.parentIssueId = event.parentIssueId ?? thread.parentIssueId;
          for (const issueId of event.childIssueIds) {
            uniquePush(thread.childIssueIds, issueId);
          }
        }
        break;
      case "followup.requested": {
        const issue = getOrCreateIssue(projection, event.issueId);
        issue.followupStatus = "awaiting-response";
        issue.lastFollowupCategory = event.category;
        issue.lastFollowupRequestedAt = event.occurredAt;
        uniquePush(issue.threadKeys, event.threadKey);
        if (thread) {
          uniquePush(thread.awaitingFollowupIssueIds, event.issueId);
        }
        break;
      }
      case "followup.resolved": {
        const issue = getOrCreateIssue(projection, event.issueId);
        issue.followupStatus = "resolved";
        issue.lastFollowupResolvedAt = event.occurredAt;
        issue.lastFollowupResolvedReason = event.reason;
        uniquePush(issue.threadKeys, event.threadKey);
        if (thread) {
          thread.awaitingFollowupIssueIds = thread.awaitingFollowupIssueIds.filter((issueId) => issueId !== event.issueId);
        }
        break;
      }
      case "issue.progressed":
      case "issue.completed":
      case "issue.blocked": {
        const issue = getOrCreateIssue(projection, event.issueId);
        const status = event.type === "issue.progressed"
          ? "progress"
          : event.type === "issue.completed"
            ? "completed"
            : "blocked";
        issue.lastStatus = status;
        issue.lastStatusAt = event.occurredAt;
        uniquePush(issue.threadKeys, event.threadKey);
        if (thread) {
          thread.issueStatuses[event.issueId] = status;
          thread.lastResolvedIssueId = event.issueId;
        }
        break;
      }
    }
  }

  return projection;
}
