import { z } from "zod";

export const managerQueryKindSchema = z.enum([
  "list-active",
  "list-today",
  "what-should-i-do",
  "inspect-work",
  "search-existing",
  "recommend-next-step",
  "reference-material",
]);

export const managerQueryScopeSchema = z.enum(["self", "team", "thread-context"]);
export const managerConversationKindSchema = z.enum(["greeting", "smalltalk", "other"]);

const confidenceSchema = z.number().min(0).max(1);

export const messageRouterConversationSchema = z.object({
  action: z.literal("conversation"),
  conversationKind: managerConversationKindSchema,
  confidence: confidenceSchema,
  reasoningSummary: z.string().trim().min(1),
});

export const messageRouterQuerySchema = z.object({
  action: z.literal("query"),
  queryKind: managerQueryKindSchema,
  queryScope: managerQueryScopeSchema,
  confidence: confidenceSchema,
  reasoningSummary: z.string().trim().min(1),
});

export const messageRouterCreateWorkSchema = z.object({
  action: z.literal("create_work"),
  confidence: confidenceSchema,
  reasoningSummary: z.string().trim().min(1),
});

export const messageRouterUpdateProgressSchema = z.object({
  action: z.literal("update_progress"),
  confidence: confidenceSchema,
  reasoningSummary: z.string().trim().min(1),
});

export const messageRouterUpdateCompletedSchema = z.object({
  action: z.literal("update_completed"),
  confidence: confidenceSchema,
  reasoningSummary: z.string().trim().min(1),
});

export const messageRouterUpdateBlockedSchema = z.object({
  action: z.literal("update_blocked"),
  confidence: confidenceSchema,
  reasoningSummary: z.string().trim().min(1),
});

export const messageRouterSchema = z.union([
  messageRouterConversationSchema,
  messageRouterQuerySchema,
  messageRouterCreateWorkSchema,
  messageRouterUpdateProgressSchema,
  messageRouterUpdateCompletedSchema,
  messageRouterUpdateBlockedSchema,
]);

export interface MessageRouterRecentEntry {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface MessageRouterThreadContext {
  intakeStatus?: "needs-clarification" | "linked-existing" | "created";
  pendingClarification: boolean;
  clarificationQuestion?: string;
  originalRequestText?: string;
  parentIssueId?: string;
  childIssueIds: string[];
  linkedIssueIds: string[];
  latestFocusIssueId?: string;
  lastResolvedIssueId?: string;
}

export interface MessageRouterLastQueryContext {
  kind: "list-active" | "list-today" | "what-should-i-do" | "inspect-work" | "search-existing" | "recommend-next-step" | "reference-material";
  scope: "self" | "team" | "thread-context";
  userMessage: string;
  replySummary: string;
  issueIds: string[];
  shownIssueIds: string[];
  remainingIssueIds: string[];
  totalItemCount: number;
  recordedAt: string;
}

export interface MessageRouterInput {
  channelId: string;
  rootThreadTs: string;
  userId: string;
  messageText: string;
  currentDate: string;
  recentThreadEntries: MessageRouterRecentEntry[];
  threadContext?: MessageRouterThreadContext;
  lastQueryContext?: MessageRouterLastQueryContext;
  taskKey?: string;
}

export interface MessageRouterConversationResult {
  action: "conversation";
  conversationKind: "greeting" | "smalltalk" | "other";
  confidence: number;
  reasoningSummary: string;
}

export interface MessageRouterQueryResult {
  action: "query";
  queryKind: "list-active" | "list-today" | "what-should-i-do" | "inspect-work" | "search-existing" | "recommend-next-step" | "reference-material";
  queryScope: "self" | "team" | "thread-context";
  confidence: number;
  reasoningSummary: string;
}

export interface MessageRouterCreateWorkResult {
  action: "create_work";
  confidence: number;
  reasoningSummary: string;
}

export interface MessageRouterUpdateProgressResult {
  action: "update_progress";
  confidence: number;
  reasoningSummary: string;
}

export interface MessageRouterUpdateCompletedResult {
  action: "update_completed";
  confidence: number;
  reasoningSummary: string;
}

export interface MessageRouterUpdateBlockedResult {
  action: "update_blocked";
  confidence: number;
  reasoningSummary: string;
}

export type MessageRouterResult =
  | MessageRouterConversationResult
  | MessageRouterQueryResult
  | MessageRouterCreateWorkResult
  | MessageRouterUpdateProgressResult
  | MessageRouterUpdateCompletedResult
  | MessageRouterUpdateBlockedResult;
