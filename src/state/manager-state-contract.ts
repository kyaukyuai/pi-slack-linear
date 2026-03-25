import { z } from "zod";

const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const managerPolicySchema = z.object({
  controlRoomChannelId: z.string().min(1),
  assistantName: z.string().min(1).default("コギト"),
  businessHours: z.object({
    timezone: z.literal("Asia/Tokyo").default("Asia/Tokyo"),
    weekdays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
    start: timeSchema.default("09:00"),
    end: timeSchema.default("18:00"),
  }),
  reviewCadence: z.object({
    morning: timeSchema.default("09:00"),
    morningEnabled: z.boolean().default(true),
    evening: timeSchema.default("17:00"),
    eveningEnabled: z.boolean().default(true),
    weeklyDay: weekdaySchema.default("mon"),
    weeklyTime: timeSchema.default("09:30"),
    weeklyEnabled: z.boolean().default(true),
  }),
  heartbeatEnabled: z.boolean().default(true),
  heartbeatIntervalMin: z.number().int().min(0).default(30),
  heartbeatActiveLookbackHours: z.number().int().positive().default(24),
  staleBusinessDays: z.number().int().positive().default(3),
  blockedBusinessDays: z.number().int().positive().default(1),
  followupCooldownHours: z.number().int().positive().default(24),
  clarificationCooldownHours: z.number().int().positive().default(12),
  fallbackOwner: z.string().min(1).default("kyaukyuai"),
  autoCreate: z.boolean().default(true),
  autoStatusUpdate: z.boolean().default(true),
  autoAssign: z.boolean().default(true),
  autoPlan: z.boolean().default(true),
  reviewExplicitFollowupCount: z.number().int().min(0).max(3).default(1),
  mentionOnFirstFollowupCategories: z.array(z.string().min(1)).default(["blocked", "overdue", "due_today", "due_soon"]),
  mentionOnRepingCategories: z.array(z.string().min(1)).default(["stale", "owner_missing"]),
  mentionAfterRepingCount: z.number().int().min(1).max(10).default(1),
  researchAutoPlanMinActions: z.number().int().min(1).max(10).default(2),
  researchAutoPlanMaxChildren: z.number().int().min(1).max(10).default(3),
  urgentPriorityThreshold: z.number().int().min(0).max(4).default(2),
});

export const ownerMapEntrySchema = z.object({
  id: z.string().min(1),
  domains: z.array(z.string().min(1)).default([]),
  keywords: z.array(z.string().min(1)).default([]),
  linearAssignee: z.string().min(1),
  slackUserId: z.string().optional(),
  primary: z.boolean().default(false),
});

export const ownerMapSchema = z.object({
  defaultOwner: z.string().min(1),
  entries: z.array(ownerMapEntrySchema),
});

export const followupLedgerEntrySchema = z.object({
  issueId: z.string().min(1),
  lastPublicFollowupAt: z.string().datetime().optional(),
  lastEscalationAt: z.string().datetime().optional(),
  lastCategory: z.string().optional(),
  requestKind: z.enum(["status", "blocked-details", "owner", "due-date"]).optional(),
  status: z.enum(["awaiting-response", "resolved"]).optional(),
  requestText: z.string().optional(),
  acceptableAnswerHint: z.string().optional(),
  sourceChannelId: z.string().optional(),
  sourceThreadTs: z.string().optional(),
  sourceMessageTs: z.string().optional(),
  assigneeDisplayName: z.string().optional(),
  rePingCount: z.number().int().min(0).optional(),
  resolvedAt: z.string().datetime().optional(),
  resolvedReason: z.enum(["response", "risk-cleared", "completed", "answered"]).optional(),
  lastResponseAt: z.string().datetime().optional(),
  lastResponseKind: z.enum(["progress", "completed", "blocked", "followup-response"]).optional(),
  lastResponseText: z.string().optional(),
  resolutionAssessment: z.object({
    answered: z.boolean(),
    answerKind: z.string().optional(),
    confidence: z.number().min(0).max(1),
    extractedFields: z.record(z.string(), z.string()).optional(),
  }).optional(),
});

export const planningLedgerEntrySchema = z.object({
  sourceThread: z.string().min(1),
  parentIssueId: z.string().optional(),
  generatedChildIssueIds: z.array(z.string()).default([]),
  planningReason: z.string().min(1),
  ownerResolution: z.enum(["mapped", "fallback"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const followupsLedgerSchema = z.array(followupLedgerEntrySchema);
export const planningLedgerSchema = z.array(planningLedgerEntrySchema);

export const webhookDeliveryStatusSchema = z.enum([
  "received",
  "noop",
  "committed",
  "failed",
  "ignored-duplicate",
  "ignored-loop",
  "ignored-unsupported",
]);

export const webhookDeliveryEntrySchema = z.object({
  deliveryId: z.string().min(1),
  webhookId: z.string().min(1).optional(),
  issueId: z.string().min(1),
  issueIdentifier: z.string().min(1),
  receivedAt: z.string().datetime(),
  status: webhookDeliveryStatusSchema,
  reason: z.string().min(1).optional(),
  createdIssueIds: z.array(z.string().min(1)).default([]),
});

export const webhookDeliveriesSchema = z.array(webhookDeliveryEntrySchema);

export const notionManagedPageEntrySchema = z.object({
  pageId: z.string().min(1),
  pageKind: z.string().min(1),
  title: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  managedBy: z.literal("cogito"),
});

export const notionManagedPagesSchema = z.array(notionManagedPageEntrySchema);

export const personalizationKindSchema = z.enum(["operating_rule", "preference_or_fact"]);
export const personalizationSourceSchema = z.enum(["explicit", "inferred"]);
export const personalizationStatusSchema = z.enum(["candidate", "promoted", "rejected", "superseded"]);
export const personalizationTargetFileSchema = z.enum(["agents", "memory"]);
export const personalizationCategorySchema = z.enum([
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

export const personalizationLedgerEntrySchema = z.object({
  id: z.string().min(1),
  kind: personalizationKindSchema,
  source: personalizationSourceSchema,
  category: personalizationCategorySchema,
  projectName: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  canonicalText: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().positive(),
  lastSeenAt: z.string().datetime(),
  status: personalizationStatusSchema,
  targetFile: personalizationTargetFileSchema,
}).superRefine((value, ctx) => {
  if (value.targetFile === "agents" && value.kind !== "operating_rule") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetFile"],
      message: "agents target requires operating_rule kind",
    });
  }
  if (value.targetFile === "memory" && value.kind !== "preference_or_fact") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetFile"],
      message: "memory target requires preference_or_fact kind",
    });
  }
  if (value.targetFile === "agents" && !["workflow", "reply-style", "priority"].includes(value.category)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: "agents target must use an operating-rule category",
    });
  }
  if (
    value.targetFile === "memory"
    && ["project-overview", "members-and-roles", "roadmap-and-milestones"].includes(value.category)
    && !value.projectName
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectName"],
      message: "projectName is required for project-scoped memory categories",
    });
  }
  if (
    value.targetFile === "memory"
    && ![
      "terminology",
      "project-overview",
      "members-and-roles",
      "roadmap-and-milestones",
      "people-and-projects",
      "preferences",
      "context",
    ].includes(value.category)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: "memory target must use a memory category",
    });
  }
});

export const personalizationLedgerSchema = z.array(personalizationLedgerEntrySchema);

export type ManagerPolicy = z.infer<typeof managerPolicySchema>;
export type OwnerMap = z.infer<typeof ownerMapSchema>;
export type OwnerMapEntry = z.infer<typeof ownerMapEntrySchema>;
export type FollowupLedgerEntry = z.infer<typeof followupLedgerEntrySchema>;
export type PlanningLedgerEntry = z.infer<typeof planningLedgerEntrySchema>;
export type WebhookDeliveryEntry = z.infer<typeof webhookDeliveryEntrySchema>;
export type NotionManagedPageEntry = z.infer<typeof notionManagedPageEntrySchema>;
export type PersonalizationLedgerEntry = z.infer<typeof personalizationLedgerEntrySchema>;

export const DEFAULT_POLICY: ManagerPolicy = {
  controlRoomChannelId: "C0ALAMDRB9V",
  assistantName: "コギト",
  businessHours: {
    timezone: "Asia/Tokyo",
    weekdays: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
  },
  reviewCadence: {
    morning: "09:00",
    morningEnabled: true,
    evening: "17:00",
    eveningEnabled: true,
    weeklyDay: "mon",
    weeklyTime: "09:30",
    weeklyEnabled: true,
  },
  heartbeatEnabled: true,
  heartbeatIntervalMin: 30,
  heartbeatActiveLookbackHours: 24,
  staleBusinessDays: 3,
  blockedBusinessDays: 1,
  followupCooldownHours: 24,
  clarificationCooldownHours: 12,
  fallbackOwner: "kyaukyuai",
  autoCreate: true,
  autoStatusUpdate: true,
  autoAssign: true,
  autoPlan: true,
  reviewExplicitFollowupCount: 1,
  mentionOnFirstFollowupCategories: ["blocked", "overdue", "due_today", "due_soon"],
  mentionOnRepingCategories: ["stale", "owner_missing"],
  mentionAfterRepingCount: 1,
  researchAutoPlanMinActions: 2,
  researchAutoPlanMaxChildren: 3,
  urgentPriorityThreshold: 2,
};

export const DEFAULT_OWNER_MAP: OwnerMap = {
  defaultOwner: "kyaukyuai",
  entries: [
    {
      id: "kyaukyuai",
      domains: ["default", "research", "slack", "linear"],
      keywords: ["slack", "linear", "bot", "manager", "調査", "確認"],
      linearAssignee: "y.kakui",
      slackUserId: "U01L86BCA9X",
      primary: true,
    },
  ],
};
