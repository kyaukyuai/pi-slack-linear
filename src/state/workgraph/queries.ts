import type { WorkgraphRepository } from "./file-backed-workgraph-repository.js";
import type {
  WorkgraphIssueProjection,
  WorkgraphProjection,
  WorkgraphThreadProjection,
} from "./projection.js";

export interface WorkgraphIssueContext {
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

export interface WorkgraphThreadContext {
  threadKey: string;
  sourceChannelId?: string;
  sourceThreadTs?: string;
  sourceMessageTs?: string;
  messageFingerprint?: string;
  originalText?: string;
  clarificationQuestion?: string;
  clarificationReasons: string[];
  clarificationRequestedAt?: string;
  lastEventAt?: string;
  intakeStatus?: "needs-clarification" | "linked-existing" | "created";
  pendingClarification: boolean;
  parentIssueId?: string;
  childIssueIds: string[];
  linkedIssueIds: string[];
  planningReason?: string;
  lastResolvedIssueId?: string;
  latestFocusIssueId?: string;
  awaitingFollowupIssueIds: string[];
  issueStatuses: Record<string, "progress" | "completed" | "blocked">;
}

export interface PendingClarificationContext extends WorkgraphThreadContext {}

export interface AwaitingFollowupContext extends WorkgraphIssueContext {
  followupStatus: "awaiting-response";
}

export interface WorkgraphThreadPlanningContext {
  thread: WorkgraphThreadContext;
  parentIssue?: WorkgraphIssueContext;
  childIssues: WorkgraphIssueContext[];
  linkedIssues: WorkgraphIssueContext[];
  latestResolvedIssue?: WorkgraphIssueContext;
}

export interface WorkgraphIssueSource {
  channelId: string;
  rootThreadTs: string;
  sourceMessageTs: string;
  lastEventAt?: string;
}

export interface ExistingThreadIntakeContext {
  threadKey: string;
  intakeStatus: "linked-existing" | "created";
  messageFingerprint: string;
  sourceMessageTs?: string;
  originalText?: string;
  parentIssueId?: string;
  childIssueIds: string[];
  linkedIssueIds: string[];
  lastResolvedIssueId?: string;
  occurredAt: string;
}

function mapIssueContext(issue: WorkgraphIssueProjection): WorkgraphIssueContext {
  return {
    issueId: issue.issueId,
    title: issue.title,
    kind: issue.kind,
    parentIssueId: issue.parentIssueId,
    dueDate: issue.dueDate,
    assignee: issue.assignee,
    threadKeys: [...issue.threadKeys],
    lastStatus: issue.lastStatus,
    lastStatusAt: issue.lastStatusAt,
    followupStatus: issue.followupStatus,
    lastFollowupCategory: issue.lastFollowupCategory,
    lastFollowupRequestedAt: issue.lastFollowupRequestedAt,
    lastFollowupResolvedAt: issue.lastFollowupResolvedAt,
    lastFollowupResolvedReason: issue.lastFollowupResolvedReason,
  };
}

function mapThreadContext(thread: WorkgraphThreadProjection): WorkgraphThreadContext {
  return {
    threadKey: thread.threadKey,
    sourceChannelId: thread.sourceChannelId,
    sourceThreadTs: thread.sourceThreadTs,
    sourceMessageTs: thread.sourceMessageTs,
    messageFingerprint: thread.messageFingerprint,
    originalText: thread.originalText,
    clarificationQuestion: thread.clarificationQuestion,
    clarificationReasons: [...thread.clarificationReasons],
    clarificationRequestedAt: thread.clarificationRequestedAt,
    lastEventAt: thread.lastEventAt,
    intakeStatus: thread.intakeStatus,
    pendingClarification: thread.pendingClarification,
    parentIssueId: thread.parentIssueId,
    childIssueIds: [...thread.childIssueIds],
    linkedIssueIds: [...thread.linkedIssueIds],
    planningReason: thread.planningReason,
    lastResolvedIssueId: thread.lastResolvedIssueId,
    latestFocusIssueId: thread.latestFocusIssueId,
    awaitingFollowupIssueIds: [...thread.awaitingFollowupIssueIds],
    issueStatuses: { ...thread.issueStatuses },
  };
}

async function loadProjection(repository: WorkgraphRepository): Promise<WorkgraphProjection> {
  return repository.project();
}

function resolveIssueContext(
  projection: WorkgraphProjection,
  issueId: string | undefined,
): WorkgraphIssueContext | undefined {
  if (!issueId) return undefined;
  const issue = projection.issues[issueId];
  return issue ? mapIssueContext(issue) : undefined;
}

function resolveLatestIssueSource(
  projection: WorkgraphProjection,
  issueId: string | undefined,
): WorkgraphIssueSource | undefined {
  if (!issueId) return undefined;
  const issue = projection.issues[issueId];
  if (!issue) return undefined;

  const candidateThreads = issue.threadKeys
    .map((threadKey) => projection.threads[threadKey])
    .filter((thread): thread is WorkgraphThreadProjection => Boolean(thread))
    .filter((thread) => Boolean(thread.sourceChannelId && thread.sourceThreadTs && thread.sourceMessageTs));

  const latestThread = candidateThreads.sort((left, right) => (
    Date.parse(right.lastEventAt ?? "") - Date.parse(left.lastEventAt ?? "")
  ))[0];

  if (!latestThread?.sourceChannelId || !latestThread.sourceThreadTs || !latestThread.sourceMessageTs) {
    return undefined;
  }

  return {
    channelId: latestThread.sourceChannelId,
    rootThreadTs: latestThread.sourceThreadTs,
    sourceMessageTs: latestThread.sourceMessageTs,
    lastEventAt: latestThread.lastEventAt,
  };
}

export async function getThreadContext(
  repository: WorkgraphRepository,
  threadKey: string,
): Promise<WorkgraphThreadContext | undefined> {
  const projection = await loadProjection(repository);
  const thread = projection.threads[threadKey];
  return thread ? mapThreadContext(thread) : undefined;
}

export async function getIssueContext(
  repository: WorkgraphRepository,
  issueId: string,
): Promise<WorkgraphIssueContext | undefined> {
  const projection = await loadProjection(repository);
  const issue = projection.issues[issueId];
  return issue ? mapIssueContext(issue) : undefined;
}

export async function listPendingClarifications(
  repository: WorkgraphRepository,
): Promise<PendingClarificationContext[]> {
  const projection = await loadProjection(repository);
  return Object.values(projection.threads)
    .filter((thread) => thread.pendingClarification)
    .map(mapThreadContext);
}

export async function getPendingClarificationForThread(
  repository: WorkgraphRepository,
  threadKey: string,
): Promise<PendingClarificationContext | undefined> {
  const projection = await loadProjection(repository);
  const thread = projection.threads[threadKey];
  if (!thread?.pendingClarification) return undefined;
  return mapThreadContext(thread);
}

export async function findExistingThreadIntakeByFingerprint(
  repository: WorkgraphRepository,
  threadKey: string,
  messageFingerprint: string,
): Promise<ExistingThreadIntakeContext | undefined> {
  const events = await repository.list();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.threadKey !== threadKey) continue;
    if (!("messageFingerprint" in event) || event.messageFingerprint !== messageFingerprint) continue;

    if (event.type === "intake.created") {
      return {
        threadKey,
        intakeStatus: "created",
        messageFingerprint: event.messageFingerprint,
        sourceMessageTs: event.sourceMessageTs,
        originalText: event.originalText,
        parentIssueId: event.parentIssueId,
        childIssueIds: [...event.childIssueIds],
        linkedIssueIds: [],
        lastResolvedIssueId: event.lastResolvedIssueId,
        occurredAt: event.occurredAt,
      };
    }

    if (event.type === "intake.linked_existing") {
      return {
        threadKey,
        intakeStatus: "linked-existing",
        messageFingerprint: event.messageFingerprint,
        sourceMessageTs: event.sourceMessageTs,
        originalText: event.originalText,
        parentIssueId: undefined,
        childIssueIds: [],
        linkedIssueIds: [...event.linkedIssueIds],
        lastResolvedIssueId: event.lastResolvedIssueId,
        occurredAt: event.occurredAt,
      };
    }

    if (event.type === "intake.corrected_existing") {
      return {
        threadKey,
        intakeStatus: "created",
        messageFingerprint: event.messageFingerprint,
        sourceMessageTs: event.sourceMessageTs,
        originalText: event.originalText,
        parentIssueId: undefined,
        childIssueIds: [event.correctedIssueId],
        linkedIssueIds: [],
        lastResolvedIssueId: event.correctedIssueId,
        occurredAt: event.occurredAt,
      };
    }
  }

  return undefined;
}

export async function listAwaitingFollowups(
  repository: WorkgraphRepository,
): Promise<AwaitingFollowupContext[]> {
  const projection = await loadProjection(repository);
  return Object.values(projection.issues)
    .filter((issue): issue is WorkgraphIssueProjection & { followupStatus: "awaiting-response" } => (
      issue.followupStatus === "awaiting-response"
    ))
    .map((issue) => ({
      ...mapIssueContext(issue),
      followupStatus: "awaiting-response",
    }));
}

export async function getLatestResolvedIssueForThread(
  repository: WorkgraphRepository,
  threadKey: string,
): Promise<WorkgraphIssueContext | undefined> {
  const projection = await loadProjection(repository);
  const thread = projection.threads[threadKey];
  if (!thread?.lastResolvedIssueId) return undefined;
  return resolveIssueContext(projection, thread.lastResolvedIssueId);
}

export async function listThreadIssueCandidates(
  repository: WorkgraphRepository,
  threadKey: string,
): Promise<WorkgraphIssueContext[]> {
  const projection = await loadProjection(repository);
  const thread = projection.threads[threadKey];
  if (!thread) return [];

  const orderedIssueIds = Array.from(new Set([
    ...(thread.lastResolvedIssueId ? [thread.lastResolvedIssueId] : []),
    ...(thread.parentIssueId ? [thread.parentIssueId] : []),
    ...thread.childIssueIds,
    ...thread.linkedIssueIds,
  ]));

  return orderedIssueIds
    .map((issueId) => resolveIssueContext(projection, issueId))
    .filter(Boolean) as WorkgraphIssueContext[];
}

export async function getThreadPlanningContext(
  repository: WorkgraphRepository,
  threadKey: string,
): Promise<WorkgraphThreadPlanningContext | undefined> {
  const projection = await loadProjection(repository);
  const thread = projection.threads[threadKey];
  if (!thread) return undefined;

  return {
    thread: mapThreadContext(thread),
    parentIssue: resolveIssueContext(projection, thread.parentIssueId),
    childIssues: thread.childIssueIds
      .map((issueId) => resolveIssueContext(projection, issueId))
      .filter(Boolean) as WorkgraphIssueContext[],
    linkedIssues: thread.linkedIssueIds
      .map((issueId) => resolveIssueContext(projection, issueId))
      .filter(Boolean) as WorkgraphIssueContext[],
    latestResolvedIssue: resolveIssueContext(projection, thread.lastResolvedIssueId),
  };
}

export async function getLatestIssueSource(
  repository: WorkgraphRepository,
  issueId: string,
): Promise<WorkgraphIssueSource | undefined> {
  const projection = await loadProjection(repository);
  return resolveLatestIssueSource(projection, issueId);
}

export async function buildIssueSourceIndex(
  repository: WorkgraphRepository,
): Promise<Record<string, WorkgraphIssueSource>> {
  const projection = await loadProjection(repository);
  return Object.fromEntries(
    Object.keys(projection.issues)
      .map((issueId) => [issueId, resolveLatestIssueSource(projection, issueId)] as const)
      .filter((entry): entry is [string, WorkgraphIssueSource] => Boolean(entry[1])),
  );
}
