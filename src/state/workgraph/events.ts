import { randomUUID } from "node:crypto";
import { z } from "zod";

const workgraphBaseEventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  threadKey: z.string().min(1).optional(),
  sourceChannelId: z.string().min(1).optional(),
  sourceThreadTs: z.string().min(1).optional(),
  sourceMessageTs: z.string().min(1).optional(),
});

const followupReasonSchema = z.enum(["response", "risk-cleared", "completed", "answered"]);
const followupRequestKindSchema = z.enum(["status", "blocked-details", "owner", "due-date"]);
const followupResponseKindSchema = z.enum(["progress", "completed", "blocked", "followup-response"]);
const reviewKindSchema = z.enum(["heartbeat", "morning-review", "evening-review", "weekly-review"]);

export const workgraphEventSchema = z.discriminatedUnion("type", [
  workgraphBaseEventSchema.extend({
    type: z.literal("intake.clarification_requested"),
    messageFingerprint: z.string().min(1),
    clarificationQuestion: z.string().min(1),
    clarificationReasons: z.array(z.string()).default([]),
    originalText: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("intake.linked_existing"),
    messageFingerprint: z.string().min(1),
    linkedIssueIds: z.array(z.string().min(1)).default([]),
    lastResolvedIssueId: z.string().min(1).optional(),
    originalText: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("intake.created"),
    messageFingerprint: z.string().min(1),
    parentIssueId: z.string().min(1).optional(),
    childIssueIds: z.array(z.string().min(1)).default([]),
    planningReason: z.string().min(1),
    ownerResolution: z.enum(["mapped", "fallback"]).optional(),
    lastResolvedIssueId: z.string().min(1).optional(),
    originalText: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("planning.parent_created"),
    issueId: z.string().min(1),
    title: z.string().min(1),
    dueDate: z.string().optional(),
    assignee: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("planning.child_created"),
    issueId: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(["execution", "research"]),
    parentIssueId: z.string().min(1).optional(),
    dueDate: z.string().optional(),
    assignee: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("planning.recorded"),
    parentIssueId: z.string().min(1).optional(),
    childIssueIds: z.array(z.string().min(1)).default([]),
    planningReason: z.string().min(1),
    ownerResolution: z.enum(["mapped", "fallback"]).optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("issue.parent_updated"),
    issueId: z.string().min(1),
    parentIssueId: z.string().min(1),
    title: z.string().min(1).optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("followup.requested"),
    issueId: z.string().min(1),
    category: z.string().min(1),
    requestKind: followupRequestKindSchema.optional(),
    requestText: z.string().optional(),
    reviewKind: reviewKindSchema.optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("followup.resolved"),
    issueId: z.string().min(1),
    reason: followupReasonSchema,
    responseKind: followupResponseKindSchema.optional(),
    textSnippet: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("issue.progressed"),
    issueId: z.string().min(1),
    dueDate: z.string().optional(),
    textSnippet: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("issue.completed"),
    issueId: z.string().min(1),
    dueDate: z.string().optional(),
    textSnippet: z.string().optional(),
  }),
  workgraphBaseEventSchema.extend({
    type: z.literal("issue.blocked"),
    issueId: z.string().min(1),
    blockedStateApplied: z.boolean(),
    dueDate: z.string().optional(),
    textSnippet: z.string().optional(),
  }),
]);

export type WorkgraphEvent = z.infer<typeof workgraphEventSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorkgraphEventInput = DistributiveOmit<WorkgraphEvent, "id"> & { id?: string };

export function buildWorkgraphThreadKey(channelId: string, rootThreadTs: string): string {
  return `${channelId}:${rootThreadTs}`;
}

export function createWorkgraphEvent(event: WorkgraphEventInput): WorkgraphEvent {
  return workgraphEventSchema.parse({
    ...event,
    id: event.id ?? randomUUID(),
  });
}
