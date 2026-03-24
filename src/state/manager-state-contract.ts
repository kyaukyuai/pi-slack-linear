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

export type ManagerPolicy = z.infer<typeof managerPolicySchema>;
export type OwnerMap = z.infer<typeof ownerMapSchema>;
export type OwnerMapEntry = z.infer<typeof ownerMapEntrySchema>;
export type FollowupLedgerEntry = z.infer<typeof followupLedgerEntrySchema>;
export type PlanningLedgerEntry = z.infer<typeof planningLedgerEntrySchema>;
export type WebhookDeliveryEntry = z.infer<typeof webhookDeliveryEntrySchema>;

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
