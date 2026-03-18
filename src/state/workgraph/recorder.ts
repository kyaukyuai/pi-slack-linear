import type { LinearIssue } from "../../lib/linear.js";
import type { FollowupLedgerEntry } from "../manager-state-contract.js";
import {
  buildThreadScopedWorkgraphFields,
  collectFollowupTransitionEvents,
  type ThreadScopedWorkgraphSource,
  type WorkgraphFollowupContext,
} from "./event-helpers.js";
import type { WorkgraphEvent, WorkgraphEventInput } from "./events.js";
import type { WorkgraphRepository } from "./file-backed-workgraph-repository.js";

export interface WorkgraphPlanningParentRecord {
  issueId: string;
  title: string;
  dueDate?: string;
  assignee?: string;
}

export interface WorkgraphPlanningChildRecord {
  issueId: string;
  title: string;
  kind: "execution" | "research";
  dueDate?: string;
  assignee?: string;
}

export interface WorkgraphPlanningOutcomeInput {
  occurredAt: string;
  source: ThreadScopedWorkgraphSource;
  messageFingerprint: string;
  parentIssue?: WorkgraphPlanningParentRecord;
  parentIssueId?: string;
  childIssues: WorkgraphPlanningChildRecord[];
  planningReason: string;
  ownerResolution?: "mapped" | "fallback";
  lastResolvedIssueId?: string;
  originalText?: string;
}

export interface WorkgraphIssueSignalRecord {
  issueId: string;
  signal: "progress" | "completed" | "blocked";
  blockedStateApplied?: boolean;
}

export interface WorkgraphIssueSignalsInput {
  occurredAt: string;
  source: ThreadScopedWorkgraphSource;
  textSnippet?: string;
  updates: WorkgraphIssueSignalRecord[];
}

function compactWorkgraphEvents(
  events: Array<WorkgraphEventInput | undefined | null | false>,
): WorkgraphEventInput[] {
  return events.filter((event): event is WorkgraphEventInput => Boolean(event));
}

export async function appendWorkgraphEvents(
  repository: WorkgraphRepository,
  events: Array<WorkgraphEventInput | undefined | null | false>,
): Promise<WorkgraphEvent[]> {
  const compacted = compactWorkgraphEvents(events);
  if (compacted.length === 0) {
    return [];
  }
  return repository.append(compacted);
}

export async function recordIntakeClarificationRequested(
  repository: WorkgraphRepository,
  input: {
    occurredAt: string;
    source: ThreadScopedWorkgraphSource;
    messageFingerprint: string;
    clarificationQuestion: string;
    clarificationReasons: string[];
    originalText?: string;
  },
): Promise<WorkgraphEvent[]> {
  return appendWorkgraphEvents(repository, [{
    type: "intake.clarification_requested",
    occurredAt: input.occurredAt,
    messageFingerprint: input.messageFingerprint,
    clarificationQuestion: input.clarificationQuestion,
    clarificationReasons: input.clarificationReasons,
    originalText: input.originalText,
    ...buildThreadScopedWorkgraphFields(input.source),
  }]);
}

export async function recordIntakeLinkedExisting(
  repository: WorkgraphRepository,
  input: {
    occurredAt: string;
    source: ThreadScopedWorkgraphSource;
    messageFingerprint: string;
    linkedIssueIds: string[];
    lastResolvedIssueId?: string;
    originalText?: string;
  },
): Promise<WorkgraphEvent[]> {
  return appendWorkgraphEvents(repository, [{
    type: "intake.linked_existing",
    occurredAt: input.occurredAt,
    messageFingerprint: input.messageFingerprint,
    linkedIssueIds: input.linkedIssueIds,
    lastResolvedIssueId: input.lastResolvedIssueId,
    originalText: input.originalText,
    ...buildThreadScopedWorkgraphFields(input.source),
  }]);
}

export async function recordPlanningOutcome(
  repository: WorkgraphRepository,
  input: WorkgraphPlanningOutcomeInput,
): Promise<WorkgraphEvent[]> {
  const sourceFields = buildThreadScopedWorkgraphFields(input.source);
  const parentIssueId = input.parentIssueId ?? input.parentIssue?.issueId;

  return appendWorkgraphEvents(repository, [
    input.parentIssue
      ? {
          type: "planning.parent_created",
          occurredAt: input.occurredAt,
          issueId: input.parentIssue.issueId,
          title: input.parentIssue.title,
          dueDate: input.parentIssue.dueDate,
          assignee: input.parentIssue.assignee,
          ...sourceFields,
        }
      : undefined,
    ...input.childIssues.map((issue) => ({
      type: "planning.child_created" as const,
      occurredAt: input.occurredAt,
      issueId: issue.issueId,
      title: issue.title,
      kind: issue.kind,
      parentIssueId,
      dueDate: issue.dueDate,
      assignee: issue.assignee,
      ...sourceFields,
    })),
    {
      type: "intake.created",
      occurredAt: input.occurredAt,
      messageFingerprint: input.messageFingerprint,
      parentIssueId,
      childIssueIds: input.childIssues.map((issue) => issue.issueId),
      planningReason: input.planningReason,
      ownerResolution: input.ownerResolution,
      lastResolvedIssueId: input.lastResolvedIssueId,
      originalText: input.originalText,
      ...sourceFields,
    },
    {
      type: "planning.recorded",
      occurredAt: input.occurredAt,
      parentIssueId,
      childIssueIds: input.childIssues.map((issue) => issue.issueId),
      planningReason: input.planningReason,
      ownerResolution: input.ownerResolution,
      ...sourceFields,
    },
  ]);
}

export async function recordFollowupTransitions(
  repository: WorkgraphRepository,
  previous: FollowupLedgerEntry[],
  current: FollowupLedgerEntry[],
  context: WorkgraphFollowupContext,
): Promise<WorkgraphEvent[]> {
  return appendWorkgraphEvents(repository, collectFollowupTransitionEvents(previous, current, context));
}

export async function recordIssueSignals(
  repository: WorkgraphRepository,
  input: WorkgraphIssueSignalsInput,
): Promise<WorkgraphEvent[]> {
  const sourceFields = buildThreadScopedWorkgraphFields(input.source);

  return appendWorkgraphEvents(repository, input.updates.map((issue) => (
    issue.signal === "progress"
      ? {
          type: "issue.progressed" as const,
          occurredAt: input.occurredAt,
          issueId: issue.issueId,
          textSnippet: input.textSnippet,
          ...sourceFields,
        }
      : issue.signal === "completed"
        ? {
            type: "issue.completed" as const,
            occurredAt: input.occurredAt,
            issueId: issue.issueId,
            textSnippet: input.textSnippet,
            ...sourceFields,
          }
        : {
            type: "issue.blocked" as const,
            occurredAt: input.occurredAt,
            issueId: issue.issueId,
            blockedStateApplied: issue.blockedStateApplied ?? false,
            textSnippet: input.textSnippet,
            ...sourceFields,
          }
  )));
}

export function buildPlanningChildRecord(
  issue: Pick<LinearIssue, "identifier" | "title" | "assignee" | "dueDate">,
  kind: "execution" | "research",
  overrides?: {
    dueDate?: string;
    assignee?: string;
  },
): WorkgraphPlanningChildRecord {
  return {
    issueId: issue.identifier,
    title: issue.title,
    kind,
    dueDate: overrides?.dueDate ?? issue.dueDate ?? undefined,
    assignee: overrides?.assignee ?? issue.assignee?.displayName ?? issue.assignee?.name ?? undefined,
  };
}
