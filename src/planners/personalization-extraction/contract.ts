import { z } from "zod";

export const personalizationObservationKindSchema = z.enum([
  "operating_rule",
  "preference_or_fact",
  "ignore",
]);

export const personalizationObservationSourceSchema = z.enum(["explicit", "inferred"]);

export const personalizationObservationCategorySchema = z.enum([
  "workflow",
  "reply-style",
  "priority",
  "terminology",
  "project-overview",
  "members-and-roles",
  "roadmap-and-milestones",
  "people-and-projects",
  "preferences",
  "context",
]);

export const personalizationObservationSchema = z.object({
  kind: personalizationObservationKindSchema,
  source: personalizationObservationSourceSchema.optional(),
  category: personalizationObservationCategorySchema.optional(),
  projectName: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  canonicalText: z.string().trim().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "ignore") {
    return;
  }
  if (!value.source) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source"],
      message: "source is required",
    });
  }
  if (!value.category) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: "category is required",
    });
  }
  if (!value.summary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message: "summary is required",
    });
  }
  if (!value.canonicalText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["canonicalText"],
      message: "canonicalText is required",
    });
  }
  if (typeof value.confidence !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confidence"],
      message: "confidence is required",
    });
  }
  if (
    value.kind === "preference_or_fact"
    && (value.category === "project-overview" || value.category === "members-and-roles" || value.category === "roadmap-and-milestones")
    && !value.projectName
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectName"],
      message: "projectName is required for project-scoped categories",
    });
  }
});

export const personalizationExtractionSchema = z.object({
  observations: z.array(personalizationObservationSchema).max(5),
});

export interface PersonalizationExtractionInput {
  turnKind: "slack-message" | "manager-system";
  latestUserMessage: string;
  latestAssistantReply: string;
  committedCommands: string[];
  rejectedReasons: string[];
  currentDate: string;
  issueContext?: {
    issueId?: string;
    issueIdentifier?: string;
  };
  workspaceAgents?: string;
  workspaceMemory?: string;
  taskKey?: string;
}

export interface PersonalizationObservation {
  kind: "operating_rule" | "preference_or_fact" | "ignore";
  source?: "explicit" | "inferred";
  category?:
    | "workflow"
    | "reply-style"
    | "priority"
    | "terminology"
    | "project-overview"
    | "members-and-roles"
    | "roadmap-and-milestones"
    | "people-and-projects"
    | "preferences"
    | "context";
  projectName?: string;
  summary?: string;
  canonicalText?: string;
  confidence?: number;
}

export interface PersonalizationExtractionResult {
  observations: PersonalizationObservation[];
}
