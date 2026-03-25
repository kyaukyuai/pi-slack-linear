import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  addLinearComment,
  addLinearProgressComment,
  addLinearRelation,
  assignLinearIssue,
  createManagedLinearIssue,
  createManagedLinearIssueBatch,
  getLinearIssue,
  markLinearIssueBlocked,
  searchLinearIssues,
  updateManagedLinearIssue,
  updateLinearIssueStateWithComment,
  type LinearCommandEnv,
  type LinearIssue,
} from "./linear.js";
import {
  archiveNotionPage,
  createNotionAgendaPage,
  updateNotionPage,
  type NotionCommandEnv,
} from "./notion.js";
import { getSlackThreadContext } from "./slack-context.js";
import { normalizeSchedulerJobs, recordManualJobRun } from "./scheduler.js";
import {
  buildSystemPaths,
  loadSchedulerJobs,
  saveSchedulerJobs,
  schedulerJobSchema,
  type SchedulerJob,
} from "./system-workspace.js";
import type {
  FollowupLedgerEntry,
  ManagerPolicy,
} from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  buildPlanningChildRecord,
  recordIntakeLinkedExisting,
  recordFollowupTransitions,
  recordIssueSignals,
  recordPlanningOutcome,
} from "../state/workgraph/recorder.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import {
  type ExistingThreadIntakeContext,
  findExistingThreadIntakeByFingerprint,
  getThreadPlanningContext,
} from "../state/workgraph/queries.js";
import {
  compactLinearIssues,
  formatAutonomousCreateReply,
  formatExistingIssueReply,
  formatSourceComment,
} from "../orchestrators/intake/formatting.js";
import { formatStatusReply, formatFollowupResolutionReply } from "../orchestrators/updates/reply-format.js";
import {
  applyFollowupAssessmentResult,
  applyFollowupExtractedFields,
  updateFollowupsWithIssueResponse,
} from "../orchestrators/updates/followup-state.js";
import type { FollowupResolutionResult } from "./pi-session.js";
import { issueMatchesCompletedState } from "../orchestrators/review/risk.js";
import {
  buildAwaitingFollowupPatch,
  upsertFollowup,
  type ReviewHelperDeps,
} from "../orchestrators/review/review-helpers.js";
import { ensureManagerStateFiles, loadManagerPolicy, saveManagerPolicy } from "./manager-state.js";
import {
  getUnifiedSchedule,
  isBuiltInScheduleId,
  isReservedSchedulerId,
  isBuiltInReviewJobId,
  reviewJobIdForBuiltInScheduleId,
  type BuiltInScheduleId,
} from "./scheduler-management.js";

const optionalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const optionalStringSchema = z.string().trim().min(1).optional();

const proposalBaseSchema = z.object({
  reasonSummary: z.string().trim().min(1),
  evidenceSummary: z.string().trim().min(1).optional(),
  dedupeKeyCandidate: z.string().trim().min(1).optional(),
});

const createIssuePayloadBaseSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  state: optionalStringSchema,
  dueDate: optionalDateSchema,
  assigneeMode: z.enum(["assign", "leave-unassigned"]),
  assignee: optionalStringSchema,
  parent: optionalStringSchema,
  priority: z.number().int().min(0).max(4).optional(),
});

const createIssuePayloadSchema = createIssuePayloadBaseSchema.superRefine((value, ctx) => {
  if (value.assigneeMode === "assign" && !value.assignee) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assignee"],
      message: "assignee is required when assigneeMode=assign",
    });
  }
  if (value.assigneeMode === "leave-unassigned" && value.assignee) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assignee"],
      message: "assignee must be omitted when assigneeMode=leave-unassigned",
    });
  }
});

const createIssueThreadParentHandlingSchema = z.enum([
  "ignore",
  "attach",
]);

const createIssueDuplicateHandlingSchema = z.enum([
  "clarify",
  "reuse-existing",
  "reuse-and-attach-parent",
  "create-new",
]);

const createIssueProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_issue"),
  planningReason: z.enum(["single-issue", "complex-request", "research-first"]).default("single-issue"),
  issue: createIssuePayloadSchema,
  threadParentHandling: createIssueThreadParentHandlingSchema,
  duplicateHandling: createIssueDuplicateHandlingSchema,
});

const createIssueBatchProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_issue_batch"),
  planningReason: z.enum(["single-issue", "complex-request", "research-first"]),
  parent: createIssuePayloadSchema,
  children: z.array(createIssuePayloadBaseSchema.extend({
    kind: z.enum(["execution", "research"]).default("execution"),
  }).superRefine((value, ctx) => {
    if (value.assigneeMode === "assign" && !value.assignee) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assignee"],
        message: "assignee is required when assigneeMode=assign",
      });
    }
    if (value.assigneeMode === "leave-unassigned" && value.assignee) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assignee"],
        message: "assignee must be omitted when assigneeMode=leave-unassigned",
      });
    }
  })).min(1).max(8),
});

const updateIssueStatusProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_issue_status"),
  issueId: z.string().trim().min(1),
  signal: z.enum(["progress", "completed", "blocked"]),
  commentBody: optionalStringSchema,
  state: optionalStringSchema,
  dueDate: optionalDateSchema,
});

const assignIssueProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("assign_issue"),
  issueId: z.string().trim().min(1),
  assignee: z.string().trim().min(1),
});

const addCommentProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("add_comment"),
  issueId: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

const addRelationProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("add_relation"),
  issueId: z.string().trim().min(1),
  relatedIssueId: z.string().trim().min(1),
  relationType: z.enum(["blocks", "blocked-by"]),
});

const setIssueParentProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("set_issue_parent"),
  issueId: z.string().trim().min(1),
  parentIssueId: z.string().trim().min(1),
});

const notionAgendaSectionSchema = z.object({
  heading: z.string().trim().min(1),
  paragraph: optionalStringSchema,
  bullets: z.array(z.string().trim().min(1)).max(10).optional(),
}).superRefine((value, ctx) => {
  if (!value.paragraph && (!value.bullets || value.bullets.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paragraph"],
      message: "section needs paragraph or bullets",
    });
  }
});

const createNotionAgendaProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_notion_agenda"),
  title: z.string().trim().min(1),
  summary: optionalStringSchema,
  parentPageId: optionalStringSchema,
  sections: z.array(notionAgendaSectionSchema).max(8).optional(),
});

const updateNotionPageProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_notion_page"),
  pageId: z.string().trim().min(1),
  title: optionalStringSchema,
  summary: optionalStringSchema,
  sections: z.array(notionAgendaSectionSchema).max(8).optional(),
  appendMode: z.literal("append"),
});

const archiveNotionPageProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("archive_notion_page"),
  pageId: z.string().trim().min(1),
});

const followupExtractedFieldsSchema = z.record(z.string(), z.string()).default({});

const resolveFollowupProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("resolve_followup"),
  issueId: z.string().trim().min(1),
  answered: z.boolean(),
  confidence: z.number().min(0).max(1),
  answerKind: optionalStringSchema,
  requestKind: z.enum(["status", "blocked-details", "owner", "due-date"]).optional(),
  responseText: z.string().trim().min(1),
  acceptableAnswerHint: optionalStringSchema,
  extractedFields: followupExtractedFieldsSchema.optional(),
});

const reviewFollowupProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("review_followup"),
  issueId: z.string().trim().min(1),
  issueTitle: z.string().trim().min(1),
  riskCategory: z.string().trim().min(1),
  requestKind: z.enum(["status", "blocked-details", "owner", "due-date"]),
  request: z.string().trim().min(1),
  acceptableAnswerHint: optionalStringSchema,
  assigneeDisplayName: optionalStringSchema,
  slackUserId: optionalStringSchema,
  source: z.object({
    channelId: z.string().trim().min(1),
    rootThreadTs: z.string().trim().min(1),
    sourceMessageTs: z.string().trim().min(1),
  }).optional(),
});

const schedulerKindSchema = z.enum(["at", "every", "daily", "weekly"]);
const schedulerWeekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const schedulerTimeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const builtInScheduleIdSchema = z.enum(["morning-review", "evening-review", "weekly-review", "heartbeat"]);

const createSchedulerJobProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_scheduler_job"),
  jobId: z.string().trim().min(1),
  channelId: optionalStringSchema,
  prompt: z.string().trim().min(1),
  kind: schedulerKindSchema,
  at: z.string().datetime().optional(),
  everySec: z.number().int().positive().optional(),
  time: schedulerTimeSchema.optional(),
  weekday: schedulerWeekdaySchema.optional(),
  enabled: z.boolean().optional().default(true),
});

const updateSchedulerJobProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_scheduler_job"),
  jobId: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  channelId: optionalStringSchema,
  prompt: optionalStringSchema,
  kind: schedulerKindSchema.optional(),
  at: z.string().datetime().optional(),
  everySec: z.number().int().positive().optional(),
  time: schedulerTimeSchema.optional(),
  weekday: schedulerWeekdaySchema.optional(),
});

const deleteSchedulerJobProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("delete_scheduler_job"),
  jobId: z.string().trim().min(1),
});

const updateBuiltinScheduleProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_builtin_schedule"),
  builtinId: builtInScheduleIdSchema,
  enabled: z.boolean().optional(),
  time: schedulerTimeSchema.optional(),
  weekday: schedulerWeekdaySchema.optional(),
  intervalMin: z.number().int().positive().optional(),
  activeLookbackHours: z.number().int().positive().optional(),
});

const runSchedulerJobNowProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("run_scheduler_job_now"),
  jobId: z.string().trim().min(1),
});

export const managerCommandProposalSchema = z.discriminatedUnion("commandType", [
  createIssueProposalSchema,
  createIssueBatchProposalSchema,
  updateIssueStatusProposalSchema,
  assignIssueProposalSchema,
  addCommentProposalSchema,
  addRelationProposalSchema,
  setIssueParentProposalSchema,
  createSchedulerJobProposalSchema,
  updateSchedulerJobProposalSchema,
  deleteSchedulerJobProposalSchema,
  updateBuiltinScheduleProposalSchema,
  runSchedulerJobNowProposalSchema,
  createNotionAgendaProposalSchema,
  updateNotionPageProposalSchema,
  archiveNotionPageProposalSchema,
  resolveFollowupProposalSchema,
  reviewFollowupProposalSchema,
]);

export type ManagerCommandProposal = z.infer<typeof managerCommandProposalSchema>;

export interface ManagerIntentReport {
  intent:
    | "conversation"
    | "query"
    | "query_schedule"
    | "run_task"
    | "create_work"
    | "create_schedule"
    | "run_schedule"
    | "update_progress"
    | "update_completed"
    | "update_blocked"
    | "update_schedule"
    | "delete_schedule"
    | "followup_resolution"
    | "review"
    | "heartbeat"
    | "scheduler";
  queryKind?: "list-active" | "list-today" | "what-should-i-do" | "inspect-work" | "search-existing" | "recommend-next-step" | "reference-material";
  queryScope?: "self" | "team" | "thread-context";
  confidence?: number;
  summary?: string;
}

export interface PendingClarificationDecisionReport {
  decision: "continue_pending" | "status_question" | "new_request" | "clear_pending";
  persistence: "keep" | "replace" | "clear";
  summary?: string;
}

export interface TaskExecutionDecisionReport {
  decision: "execute" | "noop";
  targetIssueId?: string;
  targetIssueIdentifier?: string;
  summary?: string;
}

function buildNotionEnv(config: AppConfig): NotionCommandEnv {
  return {
    ...process.env,
    NOTION_API_TOKEN: config.notionApiToken,
  };
}

export interface ManagerAgentToolCall {
  toolName: string;
  input?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface ManagerCommitMessageContext {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId?: string;
  text: string;
}

export interface ManagerCommitSystemContext {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  text: string;
}

export interface ManagerProposalRejection {
  proposal: ManagerCommandProposal;
  reason: string;
}

export interface ManagerCommittedCommand {
  commandType: ManagerCommandProposal["commandType"];
  issueIds: string[];
  summary: string;
}

export interface ManagerCommitResult {
  committed: ManagerCommittedCommand[];
  rejected: ManagerProposalRejection[];
  replySummaries: string[];
}

export interface CommitManagerCommandArgs {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "ownerMap" | "planning" | "followups" | "workgraph">;
  proposals: ManagerCommandProposal[];
  message: ManagerCommitMessageContext | ManagerCommitSystemContext;
  now: Date;
  policy: ManagerPolicy;
  env: LinearCommandEnv;
  existingThreadIntakeAtTurnStart?: ExistingThreadIntakeContext | null;
  runSchedulerJobNow?: (job: SchedulerJob) => Promise<{
    status: "ok" | "error";
    persistedSummary: string;
    commitSummary?: string;
    executedAt?: string;
  }>;
}

function normalizeTitle(title: string | undefined): string {
  return (title ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

function fingerprintText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase()
    .replace(/(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|しておいて|お願い|お願いします)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface LinearBatchCreateFailureLike {
  message: string;
  createdIdentifiers?: string[];
  createdCount?: number;
  failedStep?: {
    stage?: string;
    index?: number;
    total?: number;
    title?: string;
  };
  retryHint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLinearBatchCreateFailure(error: unknown): error is LinearBatchCreateFailureLike {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & Record<string, unknown>;
  return Array.isArray(candidate.createdIdentifiers)
    || typeof candidate.retryHint === "string"
    || isRecord(candidate.failedStep);
}

function formatLinearBatchCreateFailureReason(error: LinearBatchCreateFailureLike): string {
  const parts = ["一括起票の途中で失敗しました。"];

  if (Array.isArray(error.createdIdentifiers) && error.createdIdentifiers.length > 0) {
    parts.push(`作成済み issue: ${error.createdIdentifiers.join(", ")}。`);
  } else if (typeof error.createdCount === "number" && error.createdCount > 0) {
    parts.push(`作成済み issue: ${error.createdCount}件。`);
  }

  if (error.failedStep) {
    const location: string[] = [];
    if (error.failedStep.stage) location.push(error.failedStep.stage);
    if (typeof error.failedStep.index === "number" && typeof error.failedStep.total === "number") {
      location.push(`${error.failedStep.index}/${error.failedStep.total}`);
    }
    if (error.failedStep.title) location.push(`「${error.failedStep.title}」`);
    if (location.length > 0) {
      parts.push(`失敗箇所: ${location.join(" ")}。`);
    }
  }

  if (error.retryHint?.trim()) {
    parts.push("再試行時は作成済み issue を除いて残りだけを起票してください。");
  } else if (error.message.trim()) {
    parts.push(`${error.message.trim().replace(/[。.]$/u, "")}。`);
  }

  return parts.join(" ");
}

function dedupeProposalKey(proposal: ManagerCommandProposal): string {
  return proposal.dedupeKeyCandidate
    ?? JSON.stringify({
      commandType: proposal.commandType,
      proposal,
    });
}

function unique<T>(values: Array<T | undefined>): T[] {
  return Array.from(new Set(values.filter((value): value is T => value !== undefined)));
}

function extractIssueIdentifiers(text: string): string[] {
  return unique(
    Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
      .map((match) => match[1]?.trim())
      .filter(Boolean),
  );
}

interface CommitIssueHints {
  threadKey: string;
  explicitIssueIds: string[];
  recentIssueIds: string[];
  candidateIssueIds: string[];
  latestFocusIssueId?: string;
  lastResolvedIssueId?: string;
}

async function collectCommitIssueHints(args: CommitManagerCommandArgs): Promise<CommitIssueHints> {
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const explicitIssueIds = extractIssueIdentifiers(args.message.text);
  const recentThread = await getSlackThreadContext(
    args.config.workspaceDir,
    args.message.channelId,
    args.message.rootThreadTs,
    8,
  ).catch(() => undefined);
  const recentIssueIds = unique(
    (recentThread?.entries ?? [])
      .slice(-6)
      .flatMap((entry) => extractIssueIdentifiers(entry.text ?? "")),
  );
  const planningContext = await getThreadPlanningContext(args.repositories.workgraph, threadKey);
  const latestFocusIssueId = planningContext?.thread.latestFocusIssueId;
  const lastResolvedIssueId = planningContext?.latestResolvedIssue?.issueId ?? planningContext?.thread.lastResolvedIssueId;
  const candidateIssueIds = unique([
    latestFocusIssueId,
    lastResolvedIssueId,
    planningContext?.parentIssue?.issueId,
    ...(planningContext?.childIssues.map((issue) => issue.issueId) ?? []),
    ...(planningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
  ]);

  return {
    threadKey,
    explicitIssueIds,
    recentIssueIds,
    candidateIssueIds,
    latestFocusIssueId,
    lastResolvedIssueId,
  };
}

type SlackIssueReference = Pick<LinearIssue, "identifier" | "title"> & { url?: string | null };

function toSlackIssueReference(
  issue:
    | Pick<LinearIssue, "identifier" | "title" | "url">
    | { issueId: string; title?: string },
): SlackIssueReference {
  return {
    identifier: "identifier" in issue ? issue.identifier : issue.issueId,
    title: issue.title ?? ("identifier" in issue ? issue.identifier : issue.issueId),
    url: "url" in issue ? issue.url : undefined,
  };
}

async function loadThreadParentIssueReference(
  args: CommitManagerCommandArgs,
  threadKey: string,
): Promise<SlackIssueReference | undefined> {
  const planningContext = await getThreadPlanningContext(args.repositories.workgraph, threadKey);
  return planningContext?.parentIssue ? toSlackIssueReference(planningContext.parentIssue) : undefined;
}

function pickReusableDuplicate(
  duplicates: LinearIssue[],
  preferredParentIssueId?: string,
): LinearIssue | undefined {
  const candidates = preferredParentIssueId
    ? duplicates.filter((issue) => issue.identifier !== preferredParentIssueId)
    : duplicates;
  if (candidates.length === 0) return undefined;

  if (preferredParentIssueId) {
    const alreadyAttached = candidates.filter((issue) => issue.parent?.identifier === preferredParentIssueId);
    if (alreadyAttached.length === 1) {
      return alreadyAttached[0];
    }
    if (alreadyAttached.length > 1) {
      return undefined;
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveEffectiveParentIssueId(
  proposal: z.infer<typeof createIssueProposalSchema>,
  threadParentIssue: SlackIssueReference | undefined,
): string | undefined {
  const explicitParentIssueId = proposal.issue.parent?.trim();
  if (explicitParentIssueId) {
    return explicitParentIssueId;
  }
  return proposal.threadParentHandling === "attach" ? threadParentIssue?.identifier : undefined;
}

async function validateUpdateIssueStatusProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateIssueStatusProposalSchema>,
): Promise<string | undefined> {
  const hints = await collectCommitIssueHints(args);

  if (hints.explicitIssueIds.length > 0 && !hints.explicitIssueIds.includes(proposal.issueId)) {
    return `このメッセージでは ${hints.explicitIssueIds.join(", ")} が明示されていますが、更新提案は ${proposal.issueId} でした。更新する issue ID を明記してください。`;
  }

  if (hints.explicitIssueIds.length === 0 && hints.recentIssueIds.length === 1) {
    const recentIssueId = hints.recentIssueIds[0];
    if (recentIssueId && recentIssueId !== proposal.issueId) {
      return `直近の会話では ${recentIssueId} を見ていましたが、更新提案は ${proposal.issueId} でした。更新する issue ID を明記してください。`;
    }
  }

  if (hints.candidateIssueIds.length === 0 && hints.explicitIssueIds.length === 0) {
    return "更新対象の issue をこの thread から特定できませんでした。`AIC-123` のように issue ID を添えてください。";
  }

  if (hints.candidateIssueIds.length === 1 && hints.candidateIssueIds[0] !== proposal.issueId) {
    return `この thread で確認できる更新対象は ${hints.candidateIssueIds[0]} ですが、更新提案は ${proposal.issueId} でした。更新する issue ID を明記してください。`;
  }

  if (
    hints.candidateIssueIds.length > 1
    && !hints.explicitIssueIds.includes(proposal.issueId)
    && proposal.issueId !== hints.latestFocusIssueId
    && proposal.issueId !== hints.lastResolvedIssueId
  ) {
    return "この thread には複数の issue が紐づいているため、どの issue を更新するか判断できませんでした。`AIC-123` のように issue ID を添えてください。";
  }

  return undefined;
}

function validateFollowupProposalFields(
  current: FollowupLedgerEntry,
  proposal: z.infer<typeof resolveFollowupProposalSchema>,
): string | undefined {
  const extractedFields = proposal.extractedFields ?? {};

  if (current.requestKind && proposal.requestKind && current.requestKind !== proposal.requestKind) {
    return `待っている follow-up は ${current.requestKind} 向けですが、提案は ${proposal.requestKind} 向けでした。必要な内容を補足してください。`;
  }

  const requestKind = proposal.requestKind ?? current.requestKind;
  if (requestKind === "owner" && !extractedFields.assignee) {
    return "担当者の確認依頼を解消するには、担当者名が必要です。担当者を明記してください。";
  }
  if (requestKind === "due-date" && !extractedFields.dueDate) {
    return "期限確認の follow-up を解消するには、期限が必要です。日付を明記してください。";
  }
  if (!proposal.answered && proposal.confidence < 0.7 && Object.keys(extractedFields).length === 0) {
    return "follow-up への返答として十分か判断しきれませんでした。状況や不足情報をもう少し具体的に送ってください。";
  }
  return undefined;
}

function isMessageContext(value: CommitManagerCommandArgs["message"]): value is ManagerCommitMessageContext {
  return "userId" in value;
}

function buildOccurredAt(now: Date): string {
  return now.toISOString();
}

function buildPlanningEntry(sourceThread: string, parentIssueId: string | undefined, generatedChildIssueIds: string[], planningReason: "single-issue" | "complex-request" | "research-first", ownerResolution: "mapped" | "fallback", nowIso: string) {
  return {
    sourceThread,
    parentIssueId,
    generatedChildIssueIds,
    planningReason,
    ownerResolution,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function buildManagerCommitOwnerResolution(): "mapped" {
  return "mapped";
}

async function getExistingThreadIntakeAtTurnStart(
  args: CommitManagerCommandArgs,
  threadKey: string,
  fingerprint: string,
): Promise<ExistingThreadIntakeContext | undefined> {
  if (args.existingThreadIntakeAtTurnStart !== undefined) {
    if (
      args.existingThreadIntakeAtTurnStart
      && args.existingThreadIntakeAtTurnStart.threadKey === threadKey
      && args.existingThreadIntakeAtTurnStart.messageFingerprint === fingerprint
    ) {
      return args.existingThreadIntakeAtTurnStart;
    }
    return undefined;
  }
  return findExistingThreadIntakeByFingerprint(args.repositories.workgraph, threadKey, fingerprint);
}

function buildStatusSourceComment(message: ManagerCommitMessageContext | ManagerCommitSystemContext, heading: string): string {
  return [
    heading,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}

function buildFollowupResolutionLike(proposal: z.infer<typeof resolveFollowupProposalSchema>): FollowupResolutionResult {
  return {
    answered: proposal.answered,
    confidence: proposal.confidence,
    answerKind: proposal.answerKind,
    reasoningSummary: proposal.reasonSummary,
    extractedFields: proposal.extractedFields,
  };
}

function buildReviewDeps(): Pick<ReviewHelperDeps, "nowIso"> {
  return {
    nowIso: (now) => now.toISOString(),
  };
}

function schedulerChannelOrDefault(
  channelId: string | undefined,
  policy: ManagerPolicy,
): string {
  return channelId?.trim() || policy.controlRoomChannelId;
}

function builtInScheduleLabel(builtinId: BuiltInScheduleId): string {
  if (builtinId === "morning-review") return "朝レビュー";
  if (builtinId === "evening-review") return "夕方レビュー";
  if (builtinId === "weekly-review") return "週次レビュー";
  return "heartbeat";
}

function schedulerJobLabel(kind: z.infer<typeof schedulerKindSchema>, proposal: {
  time?: string;
  weekday?: z.infer<typeof schedulerWeekdaySchema>;
  everySec?: number;
  at?: string;
}): string {
  if (kind === "daily") {
    return `毎日 ${proposal.time}`;
  }
  if (kind === "weekly") {
    return `毎週 ${proposal.weekday} ${proposal.time}`;
  }
  if (kind === "every") {
    return `${proposal.everySec}秒ごと`;
  }
  return proposal.at ?? "単発実行";
}

function validateSchedulerChannel(
  channelId: string,
  config: AppConfig,
): string | undefined {
  return config.slackAllowedChannelIds.has(channelId)
    ? undefined
    : `channel ${channelId} は許可された Slack channel ではありません。`;
}

function validateFutureAt(
  at: string | undefined,
  now: Date,
): string | undefined {
  if (!at) return undefined;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) {
    return "at の日時を解釈できませんでした。";
  }
  if (parsed <= now.getTime()) {
    return "at に指定された日時が過去です。未来の日時を指定してください。";
  }
  return undefined;
}

function sanitizeSchedulerJobForKind(
  job: z.infer<typeof schedulerJobSchema>,
): z.infer<typeof schedulerJobSchema> {
  if (job.kind === "at") {
    return {
      ...job,
      everySec: undefined,
      time: undefined,
      weekday: undefined,
    };
  }
  if (job.kind === "every") {
    return {
      ...job,
      at: undefined,
      time: undefined,
      weekday: undefined,
    };
  }
  if (job.kind === "daily") {
    return {
      ...job,
      at: undefined,
      everySec: undefined,
      weekday: undefined,
    };
  }
  return {
    ...job,
    at: undefined,
    everySec: undefined,
  };
}

export function extractIntentReport(toolCalls: ManagerAgentToolCall[]): ManagerIntentReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const details = toolCalls[index]?.details as { intentReport?: unknown } | undefined;
    const intentReport = details?.intentReport;
    if (!intentReport || typeof intentReport !== "object") continue;
    const parsed = z.object({
      intent: z.enum([
        "conversation",
        "query",
        "query_schedule",
        "run_task",
        "create_work",
        "create_schedule",
        "update_progress",
        "update_completed",
        "update_blocked",
        "update_schedule",
        "delete_schedule",
        "followup_resolution",
        "review",
        "heartbeat",
        "scheduler",
      ]),
      queryKind: z.enum([
        "list-active",
        "list-today",
        "what-should-i-do",
        "inspect-work",
        "search-existing",
        "recommend-next-step",
        "reference-material",
      ]).optional(),
      queryScope: z.enum(["self", "team", "thread-context"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      summary: z.string().optional(),
    }).safeParse(intentReport);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

const pendingClarificationDecisionSchema = z.object({
  decision: z.enum(["continue_pending", "status_question", "new_request", "clear_pending"]),
  persistence: z.enum(["keep", "replace", "clear"]),
  summary: optionalStringSchema,
});

const taskExecutionDecisionSchema = z.object({
  decision: z.enum(["execute", "noop"]),
  targetIssueId: optionalStringSchema,
  targetIssueIdentifier: optionalStringSchema,
  summary: optionalStringSchema,
});

export function extractPendingClarificationDecision(
  toolCalls: ManagerAgentToolCall[],
): PendingClarificationDecisionReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_pending_clarification_decision") {
      continue;
    }
    const details = toolCall.details as { pendingClarificationDecision?: unknown } | undefined;
    const parsed = pendingClarificationDecisionSchema.safeParse(details?.pendingClarificationDecision);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function extractTaskExecutionDecision(
  toolCalls: ManagerAgentToolCall[],
): TaskExecutionDecisionReport | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_task_execution_decision") {
      continue;
    }
    const details = toolCall.details as { taskExecutionDecision?: unknown } | undefined;
    const parsed = taskExecutionDecisionSchema.safeParse(details?.taskExecutionDecision);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function extractManagerCommandProposals(toolCalls: ManagerAgentToolCall[]): {
  proposals: ManagerCommandProposal[];
  invalidProposalCount: number;
} {
  const proposals: ManagerCommandProposal[] = [];
  let invalidProposalCount = 0;

  for (const toolCall of toolCalls) {
    const details = toolCall.details as { proposal?: unknown } | undefined;
    if (!details?.proposal) continue;
    const parsed = managerCommandProposalSchema.safeParse(details.proposal);
    if (parsed.success) {
      proposals.push(parsed.data);
    } else {
      invalidProposalCount += 1;
    }
  }

  return { proposals, invalidProposalCount };
}

async function commitCreateIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof createIssueProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const planningLedger = await args.repositories.planning.load();
  const occurredAt = buildOccurredAt(args.now);
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const fingerprint = fingerprintText(args.message.text);
  const threadParentIssue = proposal.planningReason === "single-issue"
    ? await loadThreadParentIssueReference(args, threadKey)
    : undefined;
  const effectiveParentIssueId = resolveEffectiveParentIssueId(proposal, threadParentIssue);
  if (proposal.threadParentHandling === "attach" && !effectiveParentIssueId) {
    return {
      proposal,
      reason: "親 issue に紐づける提案でしたが、この thread から親 issue を特定できませんでした。親 issue ID を明示してください。",
    };
  }
  if (proposal.duplicateHandling === "reuse-and-attach-parent" && !effectiveParentIssueId) {
    return {
      proposal,
      reason: "既存 issue を親 issue に紐づけ直す提案でしたが、親 issue を特定できませんでした。親 issue ID を明示してください。",
    };
  }
  const existingThreadIntake = await getExistingThreadIntakeAtTurnStart(args, threadKey, fingerprint);

  if (existingThreadIntake) {
    return {
      proposal,
      reason: "duplicate intake already recorded for this thread",
    };
  }

  const duplicates = await searchLinearIssues(
    {
      query: proposal.issue.title.slice(0, 32),
      limit: 5,
    },
    args.env,
  );
  if (duplicates.length > 0) {
    const duplicateHandling = proposal.duplicateHandling;
    if (duplicateHandling !== "create-new") {
      const reusableDuplicate = duplicateHandling === "reuse-existing"
        ? pickReusableDuplicate(duplicates)
        : pickReusableDuplicate(duplicates, effectiveParentIssueId);
      const shouldAttachToParent = duplicateHandling === "reuse-and-attach-parent";

      if (duplicateHandling === "clarify") {
        return {
          proposal,
          reason: "近い既存 issue が見つかったため、新規起票にするか既存 issue を使うか確認したいです。対象 issue ID か、`新規で作成` と返してください。",
        };
      }

      if (reusableDuplicate) {
        const attachedToParent = Boolean(
          shouldAttachToParent
          && effectiveParentIssueId
          && reusableDuplicate.identifier !== effectiveParentIssueId
          && reusableDuplicate.parent?.identifier !== effectiveParentIssueId,
        );
        let reusedIssue = attachedToParent
          ? await updateManagedLinearIssue(
              {
                issueId: reusableDuplicate.identifier,
                parent: effectiveParentIssueId,
                assignee: proposal.issue.assigneeMode === "assign" ? proposal.issue.assignee : undefined,
              },
              args.env,
            )
          : reusableDuplicate;
        if (!attachedToParent && proposal.issue.assigneeMode === "assign" && proposal.issue.assignee) {
          reusedIssue = await assignLinearIssue(reusedIssue.identifier, proposal.issue.assignee, args.env);
        }
        await recordIntakeLinkedExisting(args.repositories.workgraph, {
          occurredAt,
          source: {
            channelId: args.message.channelId,
            rootThreadTs: args.message.rootThreadTs,
            messageTs: args.message.messageTs,
          },
          messageFingerprint: fingerprint,
          linkedIssueIds: [reusedIssue.identifier],
          lastResolvedIssueId: reusedIssue.identifier,
          originalText: args.message.text,
        });
        return {
          commandType: proposal.commandType,
          issueIds: [reusedIssue.identifier],
          summary: formatExistingIssueReply(
            [reusedIssue],
            threadParentIssue && shouldAttachToParent
              ? {
                  parent: threadParentIssue,
                  attachedToParent,
                }
              : undefined,
          ),
        };
      }

      if (duplicateHandling === "reuse-existing") {
        return {
          proposal,
          reason: "既存 issue を使う提案でしたが、対象を 1 件に絞れませんでした。対象 issue ID を明記してください。",
        };
      }

      if (duplicateHandling === "reuse-and-attach-parent") {
        return {
          proposal,
          reason: "既存 issue を親 issue に紐づけ直す提案でしたが、対象を 1 件に絞れませんでした。対象 issue ID を明記してください。",
        };
      }
    }

    await recordIntakeLinkedExisting(args.repositories.workgraph, {
      occurredAt,
      source: {
        channelId: args.message.channelId,
        rootThreadTs: args.message.rootThreadTs,
        messageTs: args.message.messageTs,
      },
      messageFingerprint: fingerprint,
      linkedIssueIds: duplicates.map((issue) => issue.identifier),
      lastResolvedIssueId: duplicates[0]?.identifier,
      originalText: args.message.text,
    });
    return {
      commandType: proposal.commandType,
      issueIds: duplicates.map((issue) => issue.identifier),
      summary: formatExistingIssueReply(duplicates),
    };
  }

  const issue = await createManagedLinearIssue(
    {
      title: proposal.issue.title,
      description: proposal.issue.description,
      state: proposal.issue.state,
      dueDate: proposal.issue.dueDate,
      assignee: proposal.issue.assignee,
      parent: effectiveParentIssueId,
      priority: proposal.issue.priority,
    },
    args.env,
  );
  await addLinearComment(issue.identifier, formatSourceComment(args.message, proposal.planningReason), args.env);

  const nextPlanning = [
    ...planningLedger,
    buildPlanningEntry(
      threadKey,
      effectiveParentIssueId,
      [issue.identifier],
      proposal.planningReason,
      buildManagerCommitOwnerResolution(),
      occurredAt,
    ),
  ];
  await args.repositories.planning.save(nextPlanning);
  await recordPlanningOutcome(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: args.message.channelId,
      rootThreadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
    },
    messageFingerprint: fingerprint,
    parentIssueId: effectiveParentIssueId,
    childIssues: [buildPlanningChildRecord(issue, "execution", {
      dueDate: proposal.issue.dueDate,
      assignee: proposal.issue.assignee,
    })],
    planningReason: proposal.planningReason,
    ownerResolution: buildManagerCommitOwnerResolution(),
    lastResolvedIssueId: issue.identifier,
    originalText: args.message.text,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: formatAutonomousCreateReply(
      threadParentIssue,
      [issue],
      "single-issue",
      false,
      threadParentIssue ? { attachedToExistingParent: true } : undefined,
    ),
  };
}

async function commitCreateIssueBatchProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof createIssueBatchProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (
    proposal.children.length === 1
    && normalizeTitle(proposal.parent.title) === normalizeTitle(proposal.children[0]?.title)
  ) {
    return commitCreateIssueProposal(args, {
      commandType: "create_issue",
      planningReason: "single-issue",
      threadParentHandling: "ignore",
      duplicateHandling: "create-new",
      issue: {
        title: proposal.children[0]!.title,
        description: proposal.children[0]!.description,
        dueDate: proposal.children[0]!.dueDate,
        assignee: proposal.children[0]!.assignee,
        assigneeMode: proposal.children[0]!.assigneeMode,
        priority: proposal.children[0]!.priority,
        state: proposal.children[0]!.state,
      },
      reasonSummary: proposal.reasonSummary,
      evidenceSummary: proposal.evidenceSummary,
      dedupeKeyCandidate: proposal.dedupeKeyCandidate,
    });
  }
  const planningLedger = await args.repositories.planning.load();
  const occurredAt = buildOccurredAt(args.now);
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const fingerprint = fingerprintText(args.message.text);
  const existingThreadIntake = await getExistingThreadIntakeAtTurnStart(args, threadKey, fingerprint);

  if (existingThreadIntake) {
    return {
      proposal,
      reason: "duplicate intake already recorded for this thread",
    };
  }

  let batch;
  try {
    batch = await createManagedLinearIssueBatch(
      {
        parent: {
          title: proposal.parent.title,
          description: proposal.parent.description,
          state: proposal.parent.state,
          dueDate: proposal.parent.dueDate,
          assignee: proposal.parent.assignee,
          parent: proposal.parent.parent,
          priority: proposal.parent.priority,
        },
        children: proposal.children.map((child) => ({
          title: child.title,
          description: child.description,
          state: child.state,
          dueDate: child.dueDate,
          assignee: child.assignee,
          parent: child.parent,
          priority: child.priority,
        })),
      },
      args.env,
    );
  } catch (error) {
    if (isLinearBatchCreateFailure(error)) {
      return {
        proposal,
        reason: formatLinearBatchCreateFailureReason(error),
      };
    }
    throw error;
  }

  const parent = batch.parent;
  const children = compactLinearIssues(batch.children);
  await addLinearComment(parent.identifier, formatSourceComment(args.message, proposal.planningReason), args.env);
  for (const child of children) {
    await addLinearComment(child.identifier, formatSourceComment(args.message, proposal.planningReason), args.env);
  }
  if (children.length > 1) {
    for (let index = 1; index < children.length; index += 1) {
      await addLinearRelation(children[index - 1]!.identifier, "blocks", children[index]!.identifier, args.env);
    }
  }

  const nextPlanning = [
    ...planningLedger,
    buildPlanningEntry(
      threadKey,
      parent.identifier,
      children.map((issue) => issue.identifier),
      proposal.planningReason,
      buildManagerCommitOwnerResolution(),
      occurredAt,
    ),
  ];
  await args.repositories.planning.save(nextPlanning);
  await recordPlanningOutcome(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: args.message.channelId,
      rootThreadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
    },
    messageFingerprint: fingerprint,
    parentIssue: {
      issueId: parent.identifier,
      title: parent.title,
      dueDate: proposal.parent.dueDate,
      assignee: proposal.parent.assignee,
    },
    parentIssueId: parent.identifier,
    childIssues: children.map((issue, index) => buildPlanningChildRecord(
      issue,
      proposal.children[index]?.kind ?? "execution",
      {
        dueDate: proposal.children[index]?.dueDate,
        assignee: proposal.children[index]?.assignee,
      },
    )),
    planningReason: proposal.planningReason,
    ownerResolution: buildManagerCommitOwnerResolution(),
    lastResolvedIssueId: children[0]?.identifier,
    originalText: args.message.text,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [parent.identifier, ...children.map((issue) => issue.identifier)],
    summary: formatAutonomousCreateReply(
      parent,
      children,
      proposal.planningReason,
      false,
    ),
  };
}

async function commitUpdateIssueStatusProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateIssueStatusProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const rejectionReason = await validateUpdateIssueStatusProposal(args, proposal);
  if (rejectionReason) {
    return {
      proposal,
      reason: rejectionReason,
    };
  }

  const followups = await args.repositories.followups.load();
  const occurredAt = buildOccurredAt(args.now);
  const message = args.message;
  const updatedIssues: LinearIssue[] = [];
  const blockedStateByIssueId = new Map<string, boolean>();
  const replyExtras: string[] = [];

  if (proposal.signal === "progress") {
    const progressComment = proposal.commentBody ?? buildStatusSourceComment(message, "## Progress source");
    if (proposal.dueDate || proposal.state) {
      updatedIssues.push(await updateManagedLinearIssue(
        {
          issueId: proposal.issueId,
          state: proposal.state,
          dueDate: proposal.dueDate,
          comment: progressComment.startsWith("## Progress update")
            ? progressComment
            : `## Progress update\n${progressComment.trim()}`,
        },
        args.env,
      ));
    } else {
      await addLinearProgressComment(
        proposal.issueId,
        progressComment,
        args.env,
      );
      updatedIssues.push(await getLinearIssue(proposal.issueId, args.env));
    }
  } else if (proposal.signal === "completed") {
    updatedIssues.push(await updateManagedLinearIssue(
      {
        issueId: proposal.issueId,
        state: proposal.state ?? "completed",
        dueDate: proposal.dueDate,
        comment: proposal.commentBody ?? buildStatusSourceComment(message, "## Completion source"),
      },
      args.env,
    ));
  } else {
    const blocked = await markLinearIssueBlocked(
      proposal.issueId,
      proposal.commentBody ?? buildStatusSourceComment(message, "## Blocked source"),
      args.env,
    );
    const blockedIssue = proposal.dueDate
      ? await updateManagedLinearIssue(
          {
            issueId: proposal.issueId,
            dueDate: proposal.dueDate,
          },
          args.env,
        )
      : blocked.issue;
    updatedIssues.push(blockedIssue);
    blockedStateByIssueId.set(proposal.issueId, blocked.blockedStateApplied);
  }

  if (proposal.dueDate) {
    const reflectedDueDate = updatedIssues
      .map((issue) => issue.dueDate)
      .find((dueDate): dueDate is string => Boolean(dueDate));
    if (reflectedDueDate) {
      replyExtras.push(`期限は ${reflectedDueDate} として反映しました。`);
    }
  }

  const nextFollowups = updateFollowupsWithIssueResponse(
    followups,
    updatedIssues,
    proposal.signal,
    message.text,
    args.now,
  );
  await args.repositories.followups.save(nextFollowups);
  await recordIssueSignals(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
    },
    textSnippet: message.text,
    updates: updatedIssues.map((issue) => ({
      issueId: issue.identifier,
      signal: proposal.signal,
      blockedStateApplied: blockedStateByIssueId.get(issue.identifier),
      dueDate: issue.dueDate ?? undefined,
    })),
  });
  await recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt,
    source: {
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
    },
  });

  return {
    commandType: proposal.commandType,
    issueIds: updatedIssues.map((issue) => issue.identifier),
    summary: formatStatusReply(proposal.signal, updatedIssues, replyExtras),
  };
}

async function commitAssignIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof assignIssueProposalSchema>,
): Promise<ManagerCommittedCommand> {
  const issue = await assignLinearIssue(proposal.issueId, proposal.assignee, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: `${issue.identifier} の担当を ${proposal.assignee} に更新しました。`,
  };
}

async function commitAddCommentProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof addCommentProposalSchema>,
): Promise<ManagerCommittedCommand> {
  await addLinearComment(proposal.issueId, proposal.body, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId],
    summary: `${proposal.issueId} にコメントを追加しました。`,
  };
}

async function commitAddRelationProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof addRelationProposalSchema>,
): Promise<ManagerCommittedCommand> {
  await addLinearRelation(proposal.issueId, proposal.relationType, proposal.relatedIssueId, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId, proposal.relatedIssueId],
    summary: `${proposal.issueId} と ${proposal.relatedIssueId} の依存関係を更新しました。`,
  };
}

async function commitSetIssueParentProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof setIssueParentProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (proposal.issueId === proposal.parentIssueId) {
    return {
      proposal,
      reason: "親 issue と子 issue に同じ issue ID は使えません。親子関係を確認してください。",
    };
  }

  const updatedIssue = await updateManagedLinearIssue(
    {
      issueId: proposal.issueId,
      parent: proposal.parentIssueId,
    },
    args.env,
  );

  await args.repositories.workgraph.append([
    {
      type: "issue.parent_updated",
      occurredAt: buildOccurredAt(args.now),
      threadKey: buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs),
      sourceChannelId: args.message.channelId,
      sourceThreadTs: args.message.rootThreadTs,
      sourceMessageTs: args.message.messageTs,
      issueId: proposal.issueId,
      parentIssueId: proposal.parentIssueId,
      title: updatedIssue.title,
    },
  ]);

  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId, proposal.parentIssueId],
    summary: `${proposal.issueId} を ${proposal.parentIssueId} の子 task として反映しました。`,
  };
}

async function commitCreateSchedulerJobProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof createSchedulerJobProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (isReservedSchedulerId(proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule 用の予約 ID です。別の jobId を使ってください。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  if (jobs.some((job) => job.id === proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は既に存在します。別の jobId を使うか既存 job を更新してください。`,
    };
  }

  const channelId = schedulerChannelOrDefault(proposal.channelId, args.policy);
  const invalidChannelReason = validateSchedulerChannel(channelId, args.config);
  if (invalidChannelReason) {
    return { proposal, reason: invalidChannelReason };
  }

  const invalidAtReason = validateFutureAt(proposal.at, args.now);
  if (invalidAtReason) {
    return { proposal, reason: invalidAtReason };
  }

  const parsedJob = schedulerJobSchema.safeParse(sanitizeSchedulerJobForKind({
    id: proposal.jobId,
    enabled: proposal.enabled ?? true,
    channelId,
    prompt: proposal.prompt,
    kind: proposal.kind,
    at: proposal.at,
    everySec: proposal.everySec,
    time: proposal.time,
    weekday: proposal.weekday,
  }));
  if (!parsedJob.success) {
    return {
      proposal,
      reason: parsedJob.error.issues.map((issue) => issue.message).join(" / "),
    };
  }

  const nextJobs = normalizeSchedulerJobs([...jobs, parsedJob.data]);
  await saveSchedulerJobs(systemPaths, nextJobs);
  const saved = nextJobs.find((job) => job.id === proposal.jobId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${proposal.jobId} を ${schedulerJobLabel(proposal.kind, proposal)} で登録しました。${saved?.nextRunAt ? `次回実行は ${saved.nextRunAt} です。` : ""}`.trim(),
  };
}

async function commitUpdateSchedulerJobProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateSchedulerJobProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (
    proposal.enabled === undefined
    && !proposal.channelId
    && !proposal.prompt
    && !proposal.kind
    && !proposal.at
    && !proposal.everySec
    && !proposal.time
    && !proposal.weekday
  ) {
    return {
      proposal,
      reason: "更新する scheduler 項目がありません。時刻、enabled、prompt などの変更点を指定してください。",
    };
  }
  if (isReservedSchedulerId(proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule です。更新は built-in schedule の更新 proposal を使ってください。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  const current = jobs.find((job) => job.id === proposal.jobId);
  if (!current) {
    return {
      proposal,
      reason: `${proposal.jobId} は見つかりませんでした。`,
    };
  }

  const nextChannelId = proposal.channelId === undefined
    ? current.channelId
    : schedulerChannelOrDefault(proposal.channelId, args.policy);
  const invalidChannelReason = validateSchedulerChannel(nextChannelId, args.config);
  if (invalidChannelReason) {
    return { proposal, reason: invalidChannelReason };
  }

  const nextKind = proposal.kind ?? current.kind;
  const nextJobCandidate = sanitizeSchedulerJobForKind({
    ...current,
    enabled: proposal.enabled ?? current.enabled,
    channelId: nextChannelId,
    prompt: proposal.prompt ?? current.prompt,
    kind: nextKind,
    at: proposal.at ?? current.at,
    everySec: proposal.everySec ?? current.everySec,
    time: proposal.time ?? current.time,
    weekday: proposal.weekday ?? current.weekday,
  });
  const invalidAtReason = validateFutureAt(nextJobCandidate.at, args.now);
  if (invalidAtReason) {
    return { proposal, reason: invalidAtReason };
  }

  const parsedJob = schedulerJobSchema.safeParse(nextJobCandidate);
  if (!parsedJob.success) {
    return {
      proposal,
      reason: parsedJob.error.issues.map((issue) => issue.message).join(" / "),
    };
  }

  const nextJobs = normalizeSchedulerJobs(
    jobs.map((job) => (job.id === proposal.jobId ? parsedJob.data : job)),
  );
  await saveSchedulerJobs(systemPaths, nextJobs);
  const saved = nextJobs.find((job) => job.id === proposal.jobId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${proposal.jobId} を更新しました。${saved ? `現在は ${schedulerJobLabel(saved.kind, saved)} です。` : ""}${saved?.nextRunAt ? `次回実行は ${saved.nextRunAt} です。` : ""}`.trim(),
  };
}

async function commitDeleteSchedulerJobProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof deleteSchedulerJobProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (proposal.jobId === "heartbeat" || isBuiltInReviewJobId(proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule なので削除できません。停止したい場合は無効化してください。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  if (!jobs.some((job) => job.id === proposal.jobId)) {
    return {
      proposal,
      reason: `${proposal.jobId} は見つかりませんでした。`,
    };
  }

  const nextJobs = jobs.filter((job) => job.id !== proposal.jobId);
  await saveSchedulerJobs(systemPaths, nextJobs);
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${proposal.jobId} を削除しました。`,
  };
}

async function commitUpdateBuiltinScheduleProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateBuiltinScheduleProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (
    proposal.enabled === undefined
    && !proposal.time
    && !proposal.weekday
    && proposal.intervalMin === undefined
    && proposal.activeLookbackHours === undefined
  ) {
    return {
      proposal,
      reason: "更新する built-in schedule 項目がありません。enabled、time、weekday、interval を指定してください。",
    };
  }
  if (proposal.builtinId === "heartbeat" && (proposal.time || proposal.weekday)) {
    return {
      proposal,
      reason: "heartbeat では time や weekday は更新できません。intervalMin か activeLookbackHours を指定してください。",
    };
  }
  if (
    proposal.builtinId !== "heartbeat"
    && (proposal.intervalMin !== undefined || proposal.activeLookbackHours !== undefined)
  ) {
    return {
      proposal,
      reason: "intervalMin と activeLookbackHours は heartbeat 専用です。",
    };
  }
  if (proposal.builtinId !== "weekly-review" && proposal.weekday) {
    return {
      proposal,
      reason: "weekday を変更できるのは weekly-review だけです。",
    };
  }
  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const nextPolicy = await loadManagerPolicy(systemPaths);

  if (proposal.builtinId === "heartbeat") {
    nextPolicy.heartbeatEnabled = proposal.enabled ?? nextPolicy.heartbeatEnabled;
    nextPolicy.heartbeatIntervalMin = proposal.intervalMin ?? nextPolicy.heartbeatIntervalMin;
    nextPolicy.heartbeatActiveLookbackHours = proposal.activeLookbackHours ?? nextPolicy.heartbeatActiveLookbackHours;
  } else if (proposal.builtinId === "morning-review") {
    nextPolicy.reviewCadence.morningEnabled = proposal.enabled ?? nextPolicy.reviewCadence.morningEnabled;
    nextPolicy.reviewCadence.morning = proposal.time ?? nextPolicy.reviewCadence.morning;
  } else if (proposal.builtinId === "evening-review") {
    nextPolicy.reviewCadence.eveningEnabled = proposal.enabled ?? nextPolicy.reviewCadence.eveningEnabled;
    nextPolicy.reviewCadence.evening = proposal.time ?? nextPolicy.reviewCadence.evening;
  } else {
    nextPolicy.reviewCadence.weeklyEnabled = proposal.enabled ?? nextPolicy.reviewCadence.weeklyEnabled;
    nextPolicy.reviewCadence.weeklyTime = proposal.time ?? nextPolicy.reviewCadence.weeklyTime;
    nextPolicy.reviewCadence.weeklyDay = proposal.weekday ?? nextPolicy.reviewCadence.weeklyDay;
  }

  await saveManagerPolicy(systemPaths, nextPolicy);
  await ensureManagerStateFiles(systemPaths);

  const targetId = proposal.builtinId === "heartbeat"
    ? "heartbeat"
    : reviewJobIdForBuiltInScheduleId(proposal.builtinId);
  const schedule = await getUnifiedSchedule(systemPaths, nextPolicy, targetId);
  const label = builtInScheduleLabel(proposal.builtinId);

  if (proposal.enabled === false) {
    return {
      commandType: proposal.commandType,
      issueIds: [],
      summary: `${label}を停止しました。`,
    };
  }

  if (proposal.builtinId === "heartbeat") {
    return {
      commandType: proposal.commandType,
      issueIds: [],
      summary: `${label} を ${nextPolicy.heartbeatIntervalMin}分ごとに更新しました。`,
    };
  }

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `${label} を更新しました。${schedule?.time ? `現在は ${schedule.time}` : ""}${schedule?.weekday ? ` (${schedule.weekday})` : ""}${schedule?.nextRunAt ? `。次回実行は ${schedule.nextRunAt} です。` : ""}`.replace(/^。/, ""),
  };
}

async function commitRunSchedulerJobNowProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof runSchedulerJobNowProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (!args.runSchedulerJobNow) {
    return {
      proposal,
      reason: "scheduler の即時実行は現在利用できません。",
    };
  }
  if (
    proposal.jobId === "heartbeat"
    || isBuiltInReviewJobId(proposal.jobId)
    || isBuiltInScheduleId(proposal.jobId)
  ) {
    return {
      proposal,
      reason: `${proposal.jobId} は built-in schedule なので、今回の scope では即時実行に対応していません。`,
    };
  }

  const systemPaths = buildSystemPaths(args.config.workspaceDir);
  const jobs = normalizeSchedulerJobs(await loadSchedulerJobs(systemPaths));
  const current = jobs.find((job) => job.id === proposal.jobId);
  if (!current) {
    return {
      proposal,
      reason: `${proposal.jobId} は見つかりませんでした。`,
    };
  }

  const result = await args.runSchedulerJobNow(current);
  const executedAt = result.executedAt ? new Date(result.executedAt) : args.now;
  const nextJobs = normalizeSchedulerJobs(
    jobs.map((job) => (
      job.id === proposal.jobId
        ? recordManualJobRun(job, result.status, result.persistedSummary, executedAt)
        : job
    )),
  );
  await saveSchedulerJobs(systemPaths, nextJobs);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: result.status === "error"
      ? `${proposal.jobId} の即時実行に失敗しました。${result.commitSummary ? ` ${result.commitSummary}` : ""}`.trim()
      : (result.commitSummary?.trim() || `${proposal.jobId} を今すぐ実行しました。`),
  };
}

async function commitCreateNotionAgendaProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof createNotionAgendaProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (!args.config.notionApiToken?.trim()) {
    return {
      proposal,
      reason: "Notion へのアジェンダ作成には NOTION_API_TOKEN の設定が必要です。",
    };
  }

  const parentPageId = proposal.parentPageId ?? args.config.notionAgendaParentPageId;
  if (!parentPageId?.trim()) {
    return {
      proposal,
      reason: "Notion へのアジェンダ作成先が未設定です。NOTION_AGENDA_PARENT_PAGE_ID を設定するか、親 page ID を明示してください。",
    };
  }

  const page = await createNotionAgendaPage(
    {
      title: proposal.title,
      parentPageId,
      summary: proposal.summary,
      sections: proposal.sections,
    },
    buildNotionEnv(args.config),
  );

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.title}>`
    : (page.title ?? proposal.title);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `Notion agenda created: ${linkedTitle}`,
  };
}

async function commitUpdateNotionPageProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateNotionPageProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (!args.config.notionApiToken?.trim()) {
    return {
      proposal,
      reason: "Notion page の更新には NOTION_API_TOKEN の設定が必要です。",
    };
  }
  if (!proposal.title && !proposal.summary && (!proposal.sections || proposal.sections.length === 0)) {
    return {
      proposal,
      reason: "Notion page の更新内容が不足しています。title か追記内容を明示してください。",
    };
  }

  const page = await updateNotionPage(
    {
      pageId: proposal.pageId,
      title: proposal.title,
      summary: proposal.summary,
      sections: proposal.sections,
    },
    buildNotionEnv(args.config),
  );

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.title ?? proposal.pageId}>`
    : (page.title ?? proposal.title ?? proposal.pageId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `Notion page updated: ${linkedTitle}`,
  };
}

async function commitArchiveNotionPageProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof archiveNotionPageProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  if (!args.config.notionApiToken?.trim()) {
    return {
      proposal,
      reason: "Notion page のアーカイブには NOTION_API_TOKEN の設定が必要です。",
    };
  }

  const page = await archiveNotionPage(
    proposal.pageId,
    buildNotionEnv(args.config),
  );

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.pageId}>`
    : (page.title ?? proposal.pageId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `Notion page archived: ${linkedTitle}`,
  };
}

async function commitResolveFollowupProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof resolveFollowupProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const followups = await args.repositories.followups.load();
  const current = followups.find((entry) => entry.issueId === proposal.issueId && entry.status === "awaiting-response");
  if (!current) {
    return {
      proposal,
      reason: "no awaiting follow-up found",
    };
  }

  const rejectionReason = validateFollowupProposalFields(current, proposal);
  if (rejectionReason) {
    return {
      proposal,
      reason: rejectionReason,
    };
  }

  const issue = await getLinearIssue(proposal.issueId, args.env, undefined, { includeComments: true });
  const assessment = buildFollowupResolutionLike(proposal);
  let updatedIssue = issue;
  let resolveReason: "answered" | "risk-cleared" | "completed" | undefined;

  if (proposal.requestKind === "owner" && proposal.extractedFields?.assignee) {
    updatedIssue = await applyFollowupExtractedFields(current, issue, assessment, args.message, args.env);
    resolveReason = updatedIssue.assignee ? "risk-cleared" : undefined;
  } else if (proposal.requestKind === "due-date" && proposal.extractedFields?.dueDate) {
    updatedIssue = await applyFollowupExtractedFields(current, issue, assessment, args.message, args.env);
    resolveReason = updatedIssue.dueDate ? "risk-cleared" : undefined;
  } else {
    updatedIssue = await applyFollowupExtractedFields(current, issue, assessment, args.message, args.env);
    if (proposal.answered && proposal.confidence >= 0.7) {
      resolveReason = issueMatchesCompletedState(updatedIssue) ? "completed" : "answered";
    }
  }

  let nextFollowups = updateFollowupsWithIssueResponse(
    followups,
    [updatedIssue],
    "followup-response",
    proposal.responseText,
    args.now,
  );
  nextFollowups = applyFollowupAssessmentResult(
    nextFollowups,
    updatedIssue.identifier,
    assessment,
    args.now,
    resolveReason,
  );
  await args.repositories.followups.save(nextFollowups);
  await recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt: buildOccurredAt(args.now),
    source: {
      channelId: args.message.channelId,
      rootThreadTs: args.message.rootThreadTs,
      messageTs: args.message.messageTs,
    },
  });

  return {
    commandType: proposal.commandType,
    issueIds: [updatedIssue.identifier],
    summary: formatFollowupResolutionReply(current, updatedIssue, assessment),
  };
}

async function commitReviewFollowupProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof reviewFollowupProposalSchema>,
): Promise<ManagerCommittedCommand> {
  const followups = await args.repositories.followups.load();
  const nextEntry = buildAwaitingFollowupPatch(
    followups,
    {
      issueId: proposal.issueId,
      issueTitle: proposal.issueTitle,
      issueUrl: undefined,
      request: proposal.request,
      requestKind: proposal.requestKind,
      acceptableAnswerHint: proposal.acceptableAnswerHint,
      assigneeDisplayName: proposal.assigneeDisplayName,
      slackUserId: proposal.slackUserId,
      riskCategory: proposal.riskCategory,
      shouldMention: true,
      source: proposal.source,
    },
    proposal.riskCategory,
    args.now,
    buildReviewDeps(),
  );
  const nextFollowups = upsertFollowup(followups, nextEntry);
  await args.repositories.followups.save(nextFollowups);
  await recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt: buildOccurredAt(args.now),
    reviewKind: "heartbeat",
    source: proposal.source
      ? {
          channelId: proposal.source.channelId,
          rootThreadTs: proposal.source.rootThreadTs,
          messageTs: proposal.source.sourceMessageTs,
        }
      : undefined,
  });

  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId],
    summary: `${proposal.issueId} の follow-up を作成しました。`,
  };
}

export async function commitManagerCommandProposals(args: CommitManagerCommandArgs): Promise<ManagerCommitResult> {
  const deduped = new Map<string, ManagerCommandProposal>();
  for (const proposal of args.proposals) {
    deduped.set(dedupeProposalKey(proposal), proposal);
  }

  const needsIntakeDedupeCheck = Array.from(deduped.values()).some((proposal) => (
    proposal.commandType === "create_issue" || proposal.commandType === "create_issue_batch"
  ));
  const commitArgs = needsIntakeDedupeCheck && !args.existingThreadIntakeAtTurnStart
    ? {
        ...args,
        existingThreadIntakeAtTurnStart: await findExistingThreadIntakeByFingerprint(
          args.repositories.workgraph,
          buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs),
          fingerprintText(args.message.text),
        ) ?? null,
      }
    : args;

  const committed: ManagerCommittedCommand[] = [];
  const rejected: ManagerProposalRejection[] = [];

  for (const proposal of deduped.values()) {
    const parsedProposal = managerCommandProposalSchema.safeParse(proposal);
    if (!parsedProposal.success) {
      const missingDecisionFields = parsedProposal.error.issues
        .map((issue) => issue.path.join("."))
        .filter(Boolean)
        .join(", ");
      rejected.push({
        proposal,
        reason: missingDecisionFields
          ? `判断に必要な項目が不足しているため確定できませんでした。不足項目: ${missingDecisionFields}`
          : "判断に必要な項目が不足しているため確定できませんでした。",
      });
      continue;
    }

    const validatedProposal = parsedProposal.data;
      const result = validatedProposal.commandType === "create_issue"
      ? await commitCreateIssueProposal(commitArgs, validatedProposal)
      : validatedProposal.commandType === "create_issue_batch"
        ? await commitCreateIssueBatchProposal(commitArgs, validatedProposal)
      : validatedProposal.commandType === "update_issue_status"
          ? await commitUpdateIssueStatusProposal(commitArgs, validatedProposal)
        : validatedProposal.commandType === "assign_issue"
            ? await commitAssignIssueProposal(commitArgs, validatedProposal)
          : validatedProposal.commandType === "add_comment"
              ? await commitAddCommentProposal(commitArgs, validatedProposal)
            : validatedProposal.commandType === "add_relation"
                ? await commitAddRelationProposal(commitArgs, validatedProposal)
              : validatedProposal.commandType === "set_issue_parent"
                  ? await commitSetIssueParentProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "create_scheduler_job"
                  ? await commitCreateSchedulerJobProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "update_scheduler_job"
                  ? await commitUpdateSchedulerJobProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "delete_scheduler_job"
                  ? await commitDeleteSchedulerJobProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "update_builtin_schedule"
                  ? await commitUpdateBuiltinScheduleProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "run_scheduler_job_now"
                  ? await commitRunSchedulerJobNowProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "create_notion_agenda"
                  ? await commitCreateNotionAgendaProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "update_notion_page"
                  ? await commitUpdateNotionPageProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "archive_notion_page"
                  ? await commitArchiveNotionPageProposal(commitArgs, validatedProposal)
                : validatedProposal.commandType === "resolve_followup"
                  ? await commitResolveFollowupProposal(commitArgs, validatedProposal)
                  : await commitReviewFollowupProposal(commitArgs, validatedProposal);

    if ("reason" in result) {
      rejected.push(result);
    } else {
      committed.push(result);
    }
  }

  return {
    committed,
    rejected,
    replySummaries: committed.map((entry) => entry.summary),
  };
}
