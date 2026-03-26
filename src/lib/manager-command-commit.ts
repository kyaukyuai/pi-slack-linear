import { writeFile } from "node:fs/promises";
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
import {
  applyPersonalizationObservations,
  type PersonalizationObservationInput,
} from "./personalization-commit.js";
import { getSlackThreadContext } from "./slack-context.js";
import { normalizeSchedulerJobs, recordManualJobRun } from "./scheduler.js";
import {
  buildSystemPaths,
  loadSchedulerJobs,
  saveSchedulerJobs,
  schedulerJobSchema,
  type SchedulerJob,
} from "./system-workspace.js";
import {
  hasExplicitNotionPageReference,
  loadThreadNotionPageTarget,
} from "./thread-notion-page-target.js";
import { buildThreadPaths } from "./thread-workspace.js";
import type {
  FollowupLedgerEntry,
  ManagerPolicy,
  NotionManagedPageEntry,
  OwnerMapEntry,
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
  mode: z.enum(["append", "replace_section"]).optional(),
  appendMode: z.literal("append").optional(),
  sectionHeading: optionalStringSchema,
  paragraph: optionalStringSchema,
  bullets: z.array(z.string().trim().min(1)).max(20).optional(),
});

const archiveNotionPageProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("archive_notion_page"),
  pageId: z.string().trim().min(1),
});

const workspaceMemoryCategorySchema = z.enum([
  "terminology",
  "project-overview",
  "members-and-roles",
  "roadmap-and-milestones",
  "people-and-projects",
  "preferences",
  "context",
]);

function isProjectScopedWorkspaceMemoryCategory(category: z.infer<typeof workspaceMemoryCategorySchema>): boolean {
  return category === "project-overview"
    || category === "members-and-roles"
    || category === "roadmap-and-milestones";
}

function looksLikeIssueLevelRoadmapText(text: string): boolean {
  return /AIC-\d+/i.test(text)
    || /\b(?:Backlog|In Progress|In Review|Done|Blocked|Canceled|Cancelled)\b/i.test(text)
    || /(?:現在|今日中|今週|今月|進捗)\b/.test(text)
    || /\b\d+%\b/.test(text);
}

const updateWorkspaceMemoryProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_workspace_memory"),
  sourceLabel: optionalStringSchema,
  entries: z.array(z.object({
    category: workspaceMemoryCategorySchema,
    projectName: optionalStringSchema,
    summary: z.string().trim().min(1),
    canonicalText: z.string().trim().min(1),
  }).superRefine((value, ctx) => {
    if (isProjectScopedWorkspaceMemoryCategory(value.category) && !value.projectName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectName"],
        message: "projectName is required for project-scoped memory entries",
      });
    }
  })).min(1).max(12),
});

const workspaceTextFileTargetSchema = z.enum(["agenda-template", "heartbeat-prompt"]);

const replaceWorkspaceTextFileProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("replace_workspace_text_file"),
  target: workspaceTextFileTargetSchema,
  content: z.string(),
});

const ownerMapUpdateOperationSchema = z.enum(["set-default-owner", "upsert-entry", "delete-entry"]);
const ownerMapStringListSchema = z.array(z.string().trim().min(1)).max(20).optional();

const updateOwnerMapProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_owner_map"),
  operation: ownerMapUpdateOperationSchema,
  entryId: optionalStringSchema,
  defaultOwner: optionalStringSchema,
  linearAssignee: optionalStringSchema,
  slackUserId: optionalStringSchema,
  domains: ownerMapStringListSchema,
  keywords: ownerMapStringListSchema,
  primary: z.boolean().optional(),
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
  updateWorkspaceMemoryProposalSchema,
  replaceWorkspaceTextFileProposalSchema,
  updateOwnerMapProposalSchema,
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
    | "update_workspace_config"
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
  notionPageTargetEffect?: {
    action: "set-active" | "clear";
    pageId: string;
    title?: string;
    url?: string | null;
  };
}

export interface ManagerPendingConfirmationDraft {
  kind: "owner-map";
  proposals: Array<z.infer<typeof updateOwnerMapProposalSchema>>;
  previewSummaryLines: string[];
  previewReply: string;
}

export interface ManagerCommitResult {
  committed: ManagerCommittedCommand[];
  rejected: ManagerProposalRejection[];
  replySummaries: string[];
  pendingConfirmation?: ManagerPendingConfirmationDraft;
}

export interface CommitManagerCommandArgs {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "ownerMap" | "planning" | "followups" | "personalization" | "notionPages" | "workgraph">;
  proposals: ManagerCommandProposal[];
  message: ManagerCommitMessageContext | ManagerCommitSystemContext;
  now: Date;
  policy: ManagerPolicy;
  env: LinearCommandEnv;
  existingThreadIntakeAtTurnStart?: ExistingThreadIntakeContext | null;
  ownerMapConfirmationMode?: "preview" | "confirm";
  runSchedulerJobNow?: (job: SchedulerJob) => Promise<{
    status: "ok" | "error";
    persistedSummary: string;
    commitSummary?: string;
    executedAt?: string;
  }>;
}

function resolveNotionUpdateMode(
  proposal: z.infer<typeof updateNotionPageProposalSchema>,
): "append" | "replace_section" {
  return proposal.mode ?? (proposal.appendMode ? "append" : "append");
}

function validateUpdateNotionPageProposal(
  proposal: z.infer<typeof updateNotionPageProposalSchema>,
): string | undefined {
  const mode = resolveNotionUpdateMode(proposal);
  if (mode === "append") {
    if (!proposal.title && !proposal.summary && (!proposal.sections || proposal.sections.length === 0)) {
      return "Notion page の更新内容が不足しています。title か追記内容を明示してください。";
    }
    return undefined;
  }

  if (!proposal.sectionHeading) {
    return "replace_section では sectionHeading が必要です。";
  }
  if (!proposal.paragraph && (!proposal.bullets || proposal.bullets.length === 0)) {
    return "Notion section の更新内容が不足しています。paragraph か bullets を明示してください。";
  }
  if (proposal.summary || (proposal.sections && proposal.sections.length > 0)) {
    return "replace_section では summary や sections は使えません。sectionHeading と paragraph/bullets を使ってください。";
  }
  return undefined;
}

function normalizeWorkspaceTextContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function resolveWorkspaceTextFilePath(
  workspaceDir: string,
  target: z.infer<typeof workspaceTextFileTargetSchema>,
): string {
  const systemPaths = buildSystemPaths(workspaceDir);
  return target === "agenda-template"
    ? systemPaths.agendaTemplateFile
    : systemPaths.heartbeatPromptFile;
}

function normalizeOwnerMapStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function buildOwnerMapPreviewSummaryLine(
  proposal: z.infer<typeof updateOwnerMapProposalSchema>,
): string {
  if (proposal.operation === "set-default-owner") {
    return `defaultOwner を ${proposal.defaultOwner} に変更`;
  }
  if (proposal.operation === "delete-entry") {
    return `entry ${proposal.entryId} を削除`;
  }
  return `entry ${proposal.entryId} を追加/更新`;
}

function buildOwnerMapPreviewReply(
  proposals: Array<z.infer<typeof updateOwnerMapProposalSchema>>,
): string {
  const lines = proposals.map(buildOwnerMapPreviewSummaryLine);
  return [
    "owner-map.json の変更案です。",
    ...lines.map((line) => `- ${line}`),
    "この内容でよければ「はい」か「適用して」、取り消すなら「キャンセル」と返信してください。",
  ].join("\n");
}

function validateUpdateOwnerMapProposal(
  proposal: z.infer<typeof updateOwnerMapProposalSchema>,
): string | undefined {
  if (proposal.operation === "set-default-owner") {
    if (!proposal.defaultOwner) {
      return "set-default-owner では defaultOwner が必要です。";
    }
    if (proposal.entryId || proposal.linearAssignee || proposal.slackUserId || proposal.domains || proposal.keywords || proposal.primary !== undefined) {
      return "set-default-owner では defaultOwner 以外の項目は使えません。";
    }
    return undefined;
  }

  if (!proposal.entryId) {
    return "entryId を明示してください。";
  }

  if (proposal.operation === "delete-entry") {
    if (proposal.defaultOwner || proposal.linearAssignee || proposal.slackUserId || proposal.domains || proposal.keywords || proposal.primary !== undefined) {
      return "delete-entry では entryId 以外の項目は使えません。";
    }
    return undefined;
  }

  if (!proposal.linearAssignee) {
    return "upsert-entry では linearAssignee が必要です。";
  }
  if (proposal.defaultOwner) {
    return "upsert-entry では defaultOwner は使えません。";
  }
  return undefined;
}

function applyOwnerMapProposal(
  ownerMap: {
    defaultOwner: string;
    entries: OwnerMapEntry[];
  },
  proposal: z.infer<typeof updateOwnerMapProposalSchema>,
): {
  nextOwnerMap: {
    defaultOwner: string;
    entries: OwnerMapEntry[];
  };
  summary: string;
} | ManagerProposalRejection {
  if (proposal.operation === "set-default-owner") {
    return {
      nextOwnerMap: {
        ...ownerMap,
        defaultOwner: proposal.defaultOwner!,
      },
      summary: `owner-map.json を更新しました。defaultOwner を ${proposal.defaultOwner} に変更しました。`,
    };
  }

  if (proposal.operation === "delete-entry") {
    const exists = ownerMap.entries.some((entry) => entry.id === proposal.entryId);
    if (!exists) {
      return {
        proposal,
        reason: `${proposal.entryId} は owner-map に存在しません。`,
      };
    }
    return {
      nextOwnerMap: {
        ...ownerMap,
        entries: ownerMap.entries.filter((entry) => entry.id !== proposal.entryId),
      },
      summary: `owner-map.json を更新しました。entry ${proposal.entryId} を削除しました。`,
    };
  }

  const nextEntry: OwnerMapEntry = {
    id: proposal.entryId!,
    linearAssignee: proposal.linearAssignee!,
    slackUserId: proposal.slackUserId,
    domains: normalizeOwnerMapStringList(proposal.domains),
    keywords: normalizeOwnerMapStringList(proposal.keywords),
    primary: proposal.primary ?? false,
  };
  return {
    nextOwnerMap: {
      ...ownerMap,
      entries: [
        ...ownerMap.entries.filter((entry) => entry.id !== proposal.entryId),
        nextEntry,
      ].sort((left, right) => left.id.localeCompare(right.id)),
    },
    summary: `owner-map.json を更新しました。entry ${proposal.entryId} を追加/更新しました。`,
  };
}

function upsertManagedNotionPage(
  pages: NotionManagedPageEntry[],
  entry: NotionManagedPageEntry,
): NotionManagedPageEntry[] {
  const nextPages = pages.filter((page) => page.pageId !== entry.pageId);
  nextPages.push(entry);
  nextPages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return nextPages;
}

async function resolveThreadScopedNotionPageId(
  args: CommitManagerCommandArgs,
  proposedPageId: string,
): Promise<string> {
  if (hasExplicitNotionPageReference(args.message.text)) {
    return proposedPageId;
  }

  const paths = buildThreadPaths(args.config.workspaceDir, args.message.channelId, args.message.rootThreadTs);
  const currentTarget = await loadThreadNotionPageTarget(paths).catch(() => undefined);
  if (!currentTarget?.pageId || currentTarget.pageId === proposedPageId) {
    return proposedPageId;
  }

  return currentTarget.pageId;
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

function normalizeCompletedStateAlias(state: string | undefined): string | undefined {
  const normalized = state?.trim();
  if (!normalized) return normalized;
  const lowered = normalized.toLowerCase();
  if (
    lowered === "cancel"
    || lowered === "cancelled"
    || lowered === "canceled"
    || normalized === "キャンセル"
    || normalized === "削除"
    || normalized === "取り消し"
  ) {
    return "Canceled";
  }
  return normalized;
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
        "run_schedule",
        "update_progress",
        "update_completed",
        "update_blocked",
        "update_schedule",
        "delete_schedule",
        "followup_resolution",
        "update_workspace_config",
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
  const normalizedCompletedState = proposal.signal === "completed"
    ? normalizeCompletedStateAlias(proposal.state)
    : proposal.state;
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
        state: normalizedCompletedState ?? "completed",
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
      reason: parsedJob.error.issues.map((issue: z.ZodIssue) => issue.message).join(" / "),
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
      reason: parsedJob.error.issues.map((issue: z.ZodIssue) => issue.message).join(" / "),
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

  const managedPages = await args.repositories.notionPages.load();
  await args.repositories.notionPages.save(upsertManagedNotionPage(managedPages, {
    pageId: page.id,
    pageKind: "agenda",
    title: page.title ?? proposal.title,
    url: page.url ?? undefined,
    createdAt: buildOccurredAt(args.now),
    managedBy: "cogito",
  }));

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.title}>`
    : (page.title ?? proposal.title);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `Notion agenda created: ${linkedTitle}`,
    notionPageTargetEffect: {
      action: "set-active",
      pageId: page.id,
      title: page.title ?? proposal.title,
      url: page.url ?? undefined,
    },
  };
}

async function commitUpdateNotionPageProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateNotionPageProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const mode = resolveNotionUpdateMode(proposal);
  if (!args.config.notionApiToken?.trim()) {
    return {
      proposal,
      reason: "Notion page の更新には NOTION_API_TOKEN の設定が必要です。",
    };
  }
  const validationError = validateUpdateNotionPageProposal(proposal);
  if (validationError) {
    return {
      proposal,
      reason: validationError,
    };
  }

  const managedPages = await args.repositories.notionPages.load();
  const resolvedPageId = await resolveThreadScopedNotionPageId(args, proposal.pageId);
  if (mode === "replace_section" && !managedPages.some((page) => page.pageId === resolvedPageId)) {
    return {
      proposal,
      reason: "replace_section で更新できるのはコギト管理ページのみです。対象 page は notion-pages.json に登録されていません。",
    };
  }

  let page;
  try {
    page = await updateNotionPage(
      {
        pageId: resolvedPageId,
        mode,
        title: proposal.title,
        summary: proposal.summary,
        sections: proposal.sections,
        sectionHeading: proposal.sectionHeading,
        paragraph: proposal.paragraph,
        bullets: proposal.bullets,
      },
      buildNotionEnv(args.config),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("archived")) {
      return {
        proposal,
        reason: "対象の Notion page は archive 済みです。この thread で最新の Notion page を使う場合は、そのページを明示するか同じ依頼をもう一度送ってください。",
      };
    }
    if (mode === "replace_section" && message.toLowerCase().includes("notion section")) {
      return {
        proposal,
        reason: message,
      };
    }
    throw error;
  }

  const existingManagedPage = managedPages.find((managedPage) => managedPage.pageId === page.id);
  if (existingManagedPage) {
    await args.repositories.notionPages.save(upsertManagedNotionPage(managedPages, {
      ...existingManagedPage,
      title: page.title ?? existingManagedPage.title,
      url: page.url ?? existingManagedPage.url,
    }));
  }

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.title ?? proposal.pageId}>`
    : (page.title ?? proposal.title ?? proposal.pageId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: mode === "replace_section"
      ? `Notion section updated: ${linkedTitle}`
      : `Notion page updated: ${linkedTitle}`,
    notionPageTargetEffect: {
      action: "set-active",
      pageId: page.id,
      title: page.title ?? proposal.title ?? proposal.pageId,
      url: page.url ?? undefined,
    },
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

  const resolvedPageId = await resolveThreadScopedNotionPageId(args, proposal.pageId);
  const page = await archiveNotionPage(
    resolvedPageId,
    buildNotionEnv(args.config),
  );

  const linkedTitle = page.url
    ? `<${page.url}|${page.title ?? proposal.pageId}>`
    : (page.title ?? proposal.pageId);

  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: `Notion page archived: ${linkedTitle}`,
    notionPageTargetEffect: {
      action: "clear",
      pageId: page.id,
      title: page.title ?? proposal.pageId,
      url: page.url ?? undefined,
    },
  };
}

async function commitUpdateWorkspaceMemoryProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateWorkspaceMemoryProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const invalidRoadmapEntry = proposal.entries.find((entry) =>
    entry.category === "roadmap-and-milestones"
    && looksLikeIssueLevelRoadmapText(`${entry.summary} ${entry.canonicalText}`));

  if (invalidRoadmapEntry) {
    return {
      proposal,
      reason: "roadmap-and-milestones must contain project-level milestones only, not issue-level due dates or current status",
    };
  }

  const observations: PersonalizationObservationInput[] = proposal.entries.map((entry) => ({
    kind: "preference_or_fact",
    source: "explicit",
    category: entry.category,
    projectName: entry.projectName,
    summary: entry.summary,
    canonicalText: entry.canonicalText,
    confidence: 1,
  }));
  const ledger = await args.repositories.personalization.load();
  const result = await applyPersonalizationObservations({
    paths: buildSystemPaths(args.config.workspaceDir),
    ledger,
    observations,
    now: args.now,
  });
  await args.repositories.personalization.save(result.ledger);

  const source = proposal.sourceLabel?.trim();
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: source
      ? `Workspace MEMORY を更新しました。${source} から ${proposal.entries.length} 件を反映しました。`
      : `Workspace MEMORY を更新しました。${proposal.entries.length} 件を反映しました。`,
  };
}

async function commitReplaceWorkspaceTextFileProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof replaceWorkspaceTextFileProposalSchema>,
): Promise<ManagerCommittedCommand> {
  const path = resolveWorkspaceTextFilePath(args.config.workspaceDir, proposal.target);
  await writeFile(path, normalizeWorkspaceTextContent(proposal.content), "utf8");
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: proposal.target === "agenda-template"
      ? "Notion agenda template を更新しました。"
      : "HEARTBEAT prompt を更新しました。",
  };
}

async function commitUpdateOwnerMapProposal(
  args: CommitManagerCommandArgs,
  proposal: z.infer<typeof updateOwnerMapProposalSchema>,
): Promise<ManagerCommittedCommand | ManagerProposalRejection> {
  const validationError = validateUpdateOwnerMapProposal(proposal);
  if (validationError) {
    return {
      proposal,
      reason: validationError,
    };
  }
  const ownerMap = await args.repositories.ownerMap.load();
  const result = applyOwnerMapProposal(ownerMap, proposal);
  if ("reason" in result) {
    return result;
  }
  await args.repositories.ownerMap.save(result.nextOwnerMap);
  return {
    commandType: proposal.commandType,
    issueIds: [],
    summary: result.summary,
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

function getWorkspaceConfigTarget(
  proposal: ManagerCommandProposal,
): "agenda-template" | "heartbeat-prompt" | "owner-map" | undefined {
  if (proposal.commandType === "replace_workspace_text_file") {
    return proposal.target;
  }
  if (proposal.commandType === "update_owner_map") {
    return "owner-map";
  }
  return undefined;
}

export async function commitManagerCommandProposals(args: CommitManagerCommandArgs): Promise<ManagerCommitResult> {
  const deduped = new Map<string, ManagerCommandProposal>();
  for (const proposal of args.proposals) {
    deduped.set(dedupeProposalKey(proposal), proposal);
  }
  const dedupedProposals = Array.from(deduped.values());

  const needsIntakeDedupeCheck = dedupedProposals.some((proposal) => (
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
  const rejectedKeys = new Set<string>();

  const workspaceConfigProposals = dedupedProposals.filter((proposal) => getWorkspaceConfigTarget(proposal) !== undefined);
  const workspaceConfigTargets = unique(workspaceConfigProposals.map((proposal) => getWorkspaceConfigTarget(proposal)));
  if (workspaceConfigTargets.length > 1) {
    for (const proposal of workspaceConfigProposals) {
      rejected.push({
        proposal,
        reason: "workspace config の変更は 1 turn で 1 target ずつに分けてください。",
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    }
  }

  const replaceWorkspaceTextFileProposals = workspaceConfigProposals.filter((proposal) => proposal.commandType === "replace_workspace_text_file");
  if (replaceWorkspaceTextFileProposals.length > 1) {
    for (const proposal of replaceWorkspaceTextFileProposals) {
      if (rejectedKeys.has(dedupeProposalKey(proposal))) continue;
      rejected.push({
        proposal,
        reason: "AGENDA_TEMPLATE.md と HEARTBEAT.md の更新は 1 turn で 1 proposal のみにしてください。",
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    }
  }

  const ownerMapProposals = dedupedProposals.filter((proposal): proposal is z.infer<typeof updateOwnerMapProposalSchema> => (
    proposal.commandType === "update_owner_map"
  ));
  if (ownerMapProposals.length > 0 && dedupedProposals.some((proposal) => proposal.commandType !== "update_owner_map")) {
    for (const proposal of ownerMapProposals) {
      if (rejectedKeys.has(dedupeProposalKey(proposal))) continue;
      rejected.push({
        proposal,
        reason: "owner-map の変更は専用 turn に分けてください。",
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    }
  }

  const remainingProposals = dedupedProposals.filter((proposal) => !rejectedKeys.has(dedupeProposalKey(proposal)));
  const pendingOwnerMapProposals = remainingProposals.filter((proposal): proposal is z.infer<typeof updateOwnerMapProposalSchema> => (
    proposal.commandType === "update_owner_map"
  ));
  const validPendingOwnerMapProposals: Array<z.infer<typeof updateOwnerMapProposalSchema>> = [];
  for (const proposal of pendingOwnerMapProposals) {
    const validationError = validateUpdateOwnerMapProposal(proposal);
    if (validationError) {
      rejected.push({
        proposal,
        reason: validationError,
      });
      rejectedKeys.add(dedupeProposalKey(proposal));
    } else {
      validPendingOwnerMapProposals.push(proposal);
    }
  }
  const executableProposals = remainingProposals.filter((proposal) => !rejectedKeys.has(dedupeProposalKey(proposal)));
  if (validPendingOwnerMapProposals.length > 0 && (args.ownerMapConfirmationMode ?? "preview") !== "confirm") {
    return {
      committed,
      rejected,
      replySummaries: committed.map((entry) => entry.summary),
      pendingConfirmation: {
        kind: "owner-map",
        proposals: validPendingOwnerMapProposals,
        previewSummaryLines: validPendingOwnerMapProposals.map(buildOwnerMapPreviewSummaryLine),
        previewReply: buildOwnerMapPreviewReply(validPendingOwnerMapProposals),
      },
    };
  }

  for (const proposal of executableProposals) {
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
    let result: ManagerCommittedCommand | ManagerProposalRejection;
    switch (validatedProposal.commandType) {
      case "create_issue":
        result = await commitCreateIssueProposal(commitArgs, validatedProposal);
        break;
      case "create_issue_batch":
        result = await commitCreateIssueBatchProposal(commitArgs, validatedProposal);
        break;
      case "update_issue_status":
        result = await commitUpdateIssueStatusProposal(commitArgs, validatedProposal);
        break;
      case "assign_issue":
        result = await commitAssignIssueProposal(commitArgs, validatedProposal);
        break;
      case "add_comment":
        result = await commitAddCommentProposal(commitArgs, validatedProposal);
        break;
      case "add_relation":
        result = await commitAddRelationProposal(commitArgs, validatedProposal);
        break;
      case "set_issue_parent":
        result = await commitSetIssueParentProposal(commitArgs, validatedProposal);
        break;
      case "create_scheduler_job":
        result = await commitCreateSchedulerJobProposal(commitArgs, validatedProposal);
        break;
      case "update_scheduler_job":
        result = await commitUpdateSchedulerJobProposal(commitArgs, validatedProposal);
        break;
      case "delete_scheduler_job":
        result = await commitDeleteSchedulerJobProposal(commitArgs, validatedProposal);
        break;
      case "update_builtin_schedule":
        result = await commitUpdateBuiltinScheduleProposal(commitArgs, validatedProposal);
        break;
      case "run_scheduler_job_now":
        result = await commitRunSchedulerJobNowProposal(commitArgs, validatedProposal);
        break;
      case "create_notion_agenda":
        result = await commitCreateNotionAgendaProposal(commitArgs, validatedProposal);
        break;
      case "update_notion_page":
        result = await commitUpdateNotionPageProposal(commitArgs, validatedProposal);
        break;
      case "archive_notion_page":
        result = await commitArchiveNotionPageProposal(commitArgs, validatedProposal);
        break;
      case "update_workspace_memory":
        result = await commitUpdateWorkspaceMemoryProposal(commitArgs, validatedProposal);
        break;
      case "replace_workspace_text_file":
        result = await commitReplaceWorkspaceTextFileProposal(commitArgs, validatedProposal);
        break;
      case "update_owner_map":
        result = await commitUpdateOwnerMapProposal(commitArgs, validatedProposal);
        break;
      case "resolve_followup":
        result = await commitResolveFollowupProposal(commitArgs, validatedProposal);
        break;
      case "review_followup":
        result = await commitReviewFollowupProposal(commitArgs, validatedProposal);
        break;
      default: {
        const unreachable: never = validatedProposal;
        throw new Error(`Unhandled proposal commandType: ${(unreachable as { commandType?: string }).commandType ?? "unknown"}`);
      }
    }

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
