import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { LinearCommandEnv } from "../linear.js";
import type { SchedulerJob } from "../system-workspace.js";
import type { ManagerPolicy } from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { ExistingThreadIntakeContext } from "../../state/workgraph/queries.js";

export const optionalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
export const optionalStringSchema = z.string().trim().min(1).optional();

export const proposalBaseSchema = z.object({
  reasonSummary: z.string().trim().min(1),
  evidenceSummary: z.string().trim().min(1).optional(),
  dedupeKeyCandidate: z.string().trim().min(1).optional(),
});

export const createIssuePayloadBaseSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  state: optionalStringSchema,
  dueDate: optionalDateSchema,
  assigneeMode: z.enum(["assign", "leave-unassigned"]),
  assignee: optionalStringSchema,
  parent: optionalStringSchema,
  priority: z.number().int().min(0).max(4).optional(),
});

export const createIssuePayloadSchema = createIssuePayloadBaseSchema.superRefine((value, ctx) => {
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

export const createIssueThreadParentHandlingSchema = z.enum(["ignore", "attach"]);
export const createIssueDuplicateHandlingSchema = z.enum([
  "clarify",
  "reuse-existing",
  "reuse-and-attach-parent",
  "create-new",
]);

export const createIssueProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_issue"),
  planningReason: z.enum(["single-issue", "complex-request", "research-first"]).default("single-issue"),
  issue: createIssuePayloadSchema,
  threadParentHandling: createIssueThreadParentHandlingSchema,
  duplicateHandling: createIssueDuplicateHandlingSchema,
});

export const createIssueBatchProposalSchema = proposalBaseSchema.extend({
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

export const updateIssueStatusProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_issue_status"),
  issueId: z.string().trim().min(1),
  signal: z.enum(["progress", "completed", "blocked"]),
  commentBody: optionalStringSchema,
  state: optionalStringSchema,
  dueDate: optionalDateSchema,
});

export const assignIssueProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("assign_issue"),
  issueId: z.string().trim().min(1),
  assignee: z.string().trim().min(1),
});

export const addCommentProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("add_comment"),
  issueId: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

export const addRelationProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("add_relation"),
  issueId: z.string().trim().min(1),
  relatedIssueId: z.string().trim().min(1),
  relationType: z.enum(["blocks", "blocked-by"]),
});

export const setIssueParentProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("set_issue_parent"),
  issueId: z.string().trim().min(1),
  parentIssueId: z.string().trim().min(1),
});

export const notionAgendaSectionSchema = z.object({
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

export const createNotionAgendaProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("create_notion_agenda"),
  title: z.string().trim().min(1),
  summary: optionalStringSchema,
  parentPageId: optionalStringSchema,
  sections: z.array(notionAgendaSectionSchema).max(8).optional(),
});

export const updateNotionPageProposalSchema = proposalBaseSchema.extend({
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

export const archiveNotionPageProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("archive_notion_page"),
  pageId: z.string().trim().min(1),
});

export const workspaceMemoryCategorySchema = z.enum([
  "terminology",
  "project-overview",
  "members-and-roles",
  "roadmap-and-milestones",
  "people-and-projects",
  "preferences",
  "context",
]);

export const updateWorkspaceMemoryProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_workspace_memory"),
  sourceLabel: optionalStringSchema,
  entries: z.array(z.object({
    category: workspaceMemoryCategorySchema,
    projectName: optionalStringSchema,
    summary: z.string().trim().min(1),
    canonicalText: z.string().trim().min(1),
  }).superRefine((value, ctx) => {
    if (
      (value.category === "project-overview"
        || value.category === "members-and-roles"
        || value.category === "roadmap-and-milestones")
      && !value.projectName
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectName"],
        message: "projectName is required for project-scoped memory entries",
      });
    }
  })).min(1).max(12),
});

export const workspaceTextFileTargetSchema = z.enum(["agenda-template", "heartbeat-prompt"]);

export const replaceWorkspaceTextFileProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("replace_workspace_text_file"),
  target: workspaceTextFileTargetSchema,
  content: z.string(),
});

export const ownerMapUpdateOperationSchema = z.enum(["set-default-owner", "upsert-entry", "delete-entry"]);
export const ownerMapStringListSchema = z.array(z.string().trim().min(1)).max(20).optional();

export const updateOwnerMapProposalSchema = proposalBaseSchema.extend({
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

export const followupExtractedFieldsSchema = z.record(z.string(), z.string()).default({});

export const resolveFollowupProposalSchema = proposalBaseSchema.extend({
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

export const reviewFollowupProposalSchema = proposalBaseSchema.extend({
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

export const schedulerKindSchema = z.enum(["at", "every", "daily", "weekly"]);
export const schedulerWeekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const schedulerTimeSchema = z.string().regex(/^\d{2}:\d{2}$/);
export const builtInScheduleIdSchema = z.enum(["morning-review", "evening-review", "weekly-review", "heartbeat"]);

export const createSchedulerJobProposalSchema = proposalBaseSchema.extend({
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

export const updateSchedulerJobProposalSchema = proposalBaseSchema.extend({
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

export const deleteSchedulerJobProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("delete_scheduler_job"),
  jobId: z.string().trim().min(1),
});

export const updateBuiltinScheduleProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("update_builtin_schedule"),
  builtinId: builtInScheduleIdSchema,
  enabled: z.boolean().optional(),
  time: schedulerTimeSchema.optional(),
  weekday: schedulerWeekdaySchema.optional(),
  intervalMin: z.number().int().positive().optional(),
  activeLookbackHours: z.number().int().positive().optional(),
});

export const runSchedulerJobNowProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("run_scheduler_job_now"),
  jobId: z.string().trim().min(1),
});

export const slackPostDestinationSchema = z.enum(["current-thread", "control-room-root"]);

export const postSlackMessageProposalSchema = proposalBaseSchema.extend({
  commandType: z.literal("post_slack_message"),
  destination: slackPostDestinationSchema,
  mentionSlackUserId: z.string().trim().min(1),
  targetLabel: z.string().trim().min(1),
  messageText: z.string(),
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
  postSlackMessageProposalSchema,
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
export type CreateIssueProposal = z.infer<typeof createIssueProposalSchema>;
export type CreateIssueBatchProposal = z.infer<typeof createIssueBatchProposalSchema>;
export type UpdateIssueStatusProposal = z.infer<typeof updateIssueStatusProposalSchema>;
export type AssignIssueProposal = z.infer<typeof assignIssueProposalSchema>;
export type AddCommentProposal = z.infer<typeof addCommentProposalSchema>;
export type AddRelationProposal = z.infer<typeof addRelationProposalSchema>;
export type SetIssueParentProposal = z.infer<typeof setIssueParentProposalSchema>;
export type CreateNotionAgendaProposal = z.infer<typeof createNotionAgendaProposalSchema>;
export type UpdateNotionPageProposal = z.infer<typeof updateNotionPageProposalSchema>;
export type ArchiveNotionPageProposal = z.infer<typeof archiveNotionPageProposalSchema>;
export type UpdateWorkspaceMemoryProposal = z.infer<typeof updateWorkspaceMemoryProposalSchema>;
export type ReplaceWorkspaceTextFileProposal = z.infer<typeof replaceWorkspaceTextFileProposalSchema>;
export type UpdateOwnerMapProposal = z.infer<typeof updateOwnerMapProposalSchema>;
export type ResolveFollowupProposal = z.infer<typeof resolveFollowupProposalSchema>;
export type ReviewFollowupProposal = z.infer<typeof reviewFollowupProposalSchema>;
export type CreateSchedulerJobProposal = z.infer<typeof createSchedulerJobProposalSchema>;
export type UpdateSchedulerJobProposal = z.infer<typeof updateSchedulerJobProposalSchema>;
export type DeleteSchedulerJobProposal = z.infer<typeof deleteSchedulerJobProposalSchema>;
export type UpdateBuiltinScheduleProposal = z.infer<typeof updateBuiltinScheduleProposalSchema>;
export type RunSchedulerJobNowProposal = z.infer<typeof runSchedulerJobNowProposalSchema>;
export type PostSlackMessageProposal = z.infer<typeof postSlackMessageProposalSchema>;
export const managerConversationKindSchema = z.enum(["greeting", "smalltalk", "other"]);

export const managerIntentReportSchema = z.object({
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
    "post_slack_message",
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
  conversationKind: managerConversationKindSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  summary: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.intent === "conversation" && !value.conversationKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["conversationKind"],
      message: "conversationKind is required when intent=conversation",
    });
  }
  if (value.intent !== "conversation" && value.conversationKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["conversationKind"],
      message: "conversationKind must be omitted when intent is not conversation",
    });
  }
});

export type ManagerIntentReport = z.infer<typeof managerIntentReportSchema>;

export const pendingClarificationDecisionSchema = z.object({
  decision: z.enum(["continue_pending", "status_question", "new_request", "clear_pending"]),
  persistence: z.enum(["keep", "replace", "clear"]),
  summary: optionalStringSchema,
});

export type PendingClarificationDecisionReport = z.infer<typeof pendingClarificationDecisionSchema>;

export const taskExecutionDecisionSchema = z.object({
  decision: z.enum(["execute", "noop"]),
  targetIssueId: optionalStringSchema,
  targetIssueIdentifier: optionalStringSchema,
  summary: optionalStringSchema,
});

export type TaskExecutionDecisionReport = z.infer<typeof taskExecutionDecisionSchema>;

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
  publicReply?: string;
  notionPageTargetEffect?: {
    action: "set-active" | "clear";
    pageId: string;
    title?: string;
    url?: string | null;
  };
}

export interface ManagerPendingConfirmationDraft {
  kind: "owner-map";
  proposals: UpdateOwnerMapProposal[];
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
  postSlackMessage?: (args: {
    channel: string;
    mentionSlackUserId: string;
    messageText: string;
    threadTs?: string;
  }) => Promise<{
    text: string;
    ts?: string;
  }>;
}

export type ManagerCommandHandlerResult = ManagerCommittedCommand | ManagerProposalRejection;
