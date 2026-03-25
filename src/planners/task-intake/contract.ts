import { z } from "zod";

const optionalDateSchema = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional();

export const taskPlanningChildSchema = z.object({
  title: z.string().trim().min(1),
  kind: z.enum(["execution", "research"]).default("execution"),
  dueDate: optionalDateSchema,
  assigneeHint: z.union([z.string().trim().min(1), z.null()]).optional(),
});

export const taskPlanningClarifySchema = z.object({
  action: z.literal("clarify"),
  clarificationQuestion: z.string().trim().min(1),
  clarificationReasons: z.array(z.enum(["scope", "due_date", "execution_plan"])).default([]),
});

export const taskPlanningCreateSchema = z.object({
  action: z.literal("create"),
  planningReason: z.enum(["single-issue", "complex-request", "research-first"]),
  parentTitle: z.union([z.string().trim().min(1), z.null()]).optional(),
  parentDueDate: optionalDateSchema,
  children: z.array(taskPlanningChildSchema).min(1).max(8),
}).superRefine((value, ctx) => {
  const hasParent = typeof value.parentTitle === "string" && value.parentTitle.trim().length > 0;
  if (value.planningReason !== "single-issue" && !hasParent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "parentTitle is required for complex-request and research-first",
      path: ["parentTitle"],
    });
  }
  if (value.planningReason === "single-issue" && value.children.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "single-issue must have exactly one child",
      path: ["children"],
    });
  }
  if (value.planningReason === "research-first" && !value.children.some((child) => child.kind === "research")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "research-first must include at least one research child",
      path: ["children"],
    });
  }
});

export const taskPlanningUpdateExistingSchema = z.object({
  action: z.literal("update_existing"),
  targetIssueId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  dueDate: optionalDateSchema,
  assigneeHint: z.union([z.string().trim().min(1), z.null()]).optional(),
});

export const taskPlanningSchema = z.union([
  taskPlanningClarifySchema,
  taskPlanningCreateSchema,
  taskPlanningUpdateExistingSchema,
]);

export interface TaskPlanningThreadContext {
  latestResolvedIssueId?: string;
  latestResolvedIssueTitle?: string;
  latestResolvedIssueLastStatus?: "progress" | "completed" | "blocked";
  threadIntakeStatus?: "needs-clarification" | "linked-existing" | "created";
  threadChildIssueIds?: string[];
  threadParentIssueId?: string;
}

export interface TaskPlanningInput {
  channelId: string;
  rootThreadTs: string;
  originalRequest: string;
  latestUserMessage: string;
  combinedRequest: string;
  clarificationQuestion?: string;
  currentDate: string;
  workspaceAgents?: string;
  workspaceMemory?: string;
  threadContext?: TaskPlanningThreadContext;
  taskKey?: string;
}

export interface TaskPlanningChild {
  title: string;
  kind: "execution" | "research";
  dueDate?: string;
  assigneeHint?: string;
}

export interface TaskPlanningResultClarify {
  action: "clarify";
  clarificationQuestion: string;
  clarificationReasons: Array<"scope" | "due_date" | "execution_plan">;
}

export interface TaskPlanningResultCreate {
  action: "create";
  planningReason: "single-issue" | "complex-request" | "research-first";
  parentTitle?: string;
  parentDueDate?: string;
  children: TaskPlanningChild[];
}

export interface TaskPlanningResultUpdateExisting {
  action: "update_existing";
  targetIssueId: string;
  title: string;
  description: string;
  dueDate?: string;
  assigneeHint?: string;
}

export type TaskPlanningResult =
  | TaskPlanningResultClarify
  | TaskPlanningResultCreate
  | TaskPlanningResultUpdateExisting;
