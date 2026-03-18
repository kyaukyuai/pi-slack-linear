import { writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { join } from "node:path";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  createReadTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { getLinearIssue } from "./linear.js";
import { createLinearCustomTools } from "./linear-tools.js";
import { loadIntakeLedger, type IntakeLedgerEntry } from "./manager-state.js";
import type { TaskIntent } from "./slack.js";
import { buildSystemPaths } from "./system-workspace.js";
import type { AttachmentRecord, ThreadPaths } from "./thread-workspace.js";

export interface AgentInput {
  channelId: string;
  userId: string;
  text: string;
  rootThreadTs: string;
  intent: TaskIntent;
  attachments: AttachmentRecord[];
}

export interface SystemAgentInput {
  kind: "heartbeat" | "scheduler";
  channelId: string;
  text: string;
  metadata?: Record<string, string>;
}

export interface ResearchSynthesisInput {
  channelId: string;
  rootThreadTs: string;
  taskTitle: string;
  sourceMessage: string;
  slackThreadSummary: string;
  recentChannelSummary: string;
  relatedIssuesSummary: string;
  webSummary: string;
  taskKey?: string;
}

export interface ResearchNextAction {
  title: string;
  purpose: string;
  ownerHint?: string;
  confidence: number;
}

export interface ResearchSynthesisResult {
  findings: string[];
  uncertainties: string[];
  nextActions: ResearchNextAction[];
}

export interface FollowupResolutionInput {
  issueId: string;
  issueTitle: string;
  requestKind: "status" | "blocked-details" | "owner" | "due-date";
  requestText: string;
  acceptableAnswerHint?: string;
  responseText: string;
  taskKey?: string;
}

export interface FollowupResolutionResult {
  answered: boolean;
  answerKind?: string;
  confidence: number;
  extractedFields?: Record<string, string>;
  reasoningSummary?: string;
}

export interface TaskPlanningInput {
  channelId: string;
  rootThreadTs: string;
  originalRequest: string;
  latestUserMessage: string;
  combinedRequest: string;
  clarificationQuestion?: string;
  currentDate: string;
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

export type TaskPlanningResult = TaskPlanningResultClarify | TaskPlanningResultCreate;

interface SharedRuntime {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Awaited<ReturnType<ModelRegistry["getAvailable"]>>[number];
}

interface ThreadRuntime {
  session: AgentSession;
  lastUsedAt: number;
}

const DEFAULT_THREAD_IDLE_MS = 15 * 60 * 1000;
let sharedRuntimePromise: Promise<SharedRuntime> | undefined;
const threadRuntimePromises = new Map<string, Promise<ThreadRuntime>>();

export interface ThreadPromptCandidateIssue {
  issueId: string;
  title?: string;
}

export interface ThreadPromptContext {
  lastResolvedIssueId?: string;
  parentIssueId?: string;
  childIssueIds: string[];
  duplicateReuse: boolean;
  pendingClarification: boolean;
  preferredIssueIds: string[];
  candidateIssues: ThreadPromptCandidateIssue[];
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function findThreadLedgerEntries(
  entries: IntakeLedgerEntry[],
  channelId: string,
  rootThreadTs: string,
): IntakeLedgerEntry[] {
  return entries.filter((entry) => entry.sourceChannelId === channelId && entry.sourceThreadTs === rootThreadTs);
}

async function loadThreadPromptContext(config: AppConfig, input: AgentInput): Promise<ThreadPromptContext | undefined> {
  const systemPaths = buildSystemPaths(config.workspaceDir);
  const ledger = await loadIntakeLedger(systemPaths).catch(() => []);
  const threadEntries = findThreadLedgerEntries(ledger, input.channelId, input.rootThreadTs);
  if (threadEntries.length === 0) {
    return undefined;
  }

  const latestEntry = threadEntries[threadEntries.length - 1];
  const childIssueIds = unique(threadEntries.flatMap((entry) => entry.childIssueIds ?? []).filter(Boolean)) as string[];
  const parentIssueIds = unique(threadEntries.map((entry) => entry.parentIssueId).filter(Boolean)) as string[];
  const candidateIds = unique(
    threadEntries.flatMap((entry) => [
      entry.lastResolvedIssueId,
      entry.parentIssueId,
      ...(entry.childIssueIds ?? []),
    ].filter(Boolean)),
  ) as string[];

  const preferredIssueIds = unique([
    ...childIssueIds,
    latestEntry.lastResolvedIssueId,
    ...latestEntry.childIssueIds,
    latestEntry.parentIssueId,
    ...parentIssueIds,
    ...candidateIds,
  ].filter(Boolean)) as string[];

  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  const candidateIssues = candidateIds.length > 1
    ? (await Promise.all(
        candidateIds.slice(0, 6).map(async (issueId) => {
          try {
            const issue = await getLinearIssue(issueId, env);
            return {
              issueId,
              title: issue.title.length > 96 ? `${issue.title.slice(0, 93)}...` : issue.title,
            };
          } catch {
            return { issueId };
          }
        }),
      ))
    : [];

  return {
    lastResolvedIssueId: latestEntry.lastResolvedIssueId,
    parentIssueId: latestEntry.parentIssueId ?? parentIssueIds[0],
    childIssueIds,
    duplicateReuse: threadEntries.some((entry) => entry.status === "linked-existing"),
    pendingClarification: threadEntries.some((entry) => entry.status === "needs-clarification"),
    preferredIssueIds,
    candidateIssues,
  };
}

export function buildSystemPrompt(config: AppConfig): string {
  return [
    "You are a Japanese Slack execution manager for task management.",
    "Reply in Japanese.",
    "Linear is the only system of record for tracked tasks.",
    "Slack thread is the primary operator surface for day-to-day work.",
    "Do not use or invent any internal todo list.",
    "Treat the allowed Slack channel as a control room for task execution.",
    "Use Linear to store truth, but return normal task execution results to the originating Slack thread.",
    "Only use the control room for proactive reviews, urgent follow-ups, and fallback-owner notices.",
    "Create, search, inspect, assign, and update Linear issues when task progression requires it.",
    "Prefer existing work in this order: thread-linked issue, existing parent issue, existing duplicate, then new issue.",
    "Search before creating, and inspect the issue hierarchy before updating tracked work.",
    "If a thread already maps to an issue, prefer updating that issue for progress, completion, and blocked signals.",
    "For progress, completion, and blocked signals, prefer the most specific child issue over the parent issue.",
    "For larger requests, create a parent issue and execution-sized child issues.",
    "When research is required, gather evidence from Slack thread context, related Linear issues, and lightweight web search before proposing follow-up tasks.",
    "When research is required, save detailed findings to Linear and return only a short summary and next action to Slack.",
    "Use owner hints from the conversation when assigning work, but do not ask for API keys or workspace/team identifiers.",
    "If the request is ambiguous, ask exactly one concise follow-up question before taking action.",
    "Do not ask the user for API keys. Slack and Linear credentials are already configured in the environment.",
    "Use the dedicated Linear tools for tracked task work.",
    `The fixed Linear workspace slug is ${config.linearWorkspace}.`,
    `The fixed Linear team key is ${config.linearTeamKey}.`,
    "Interpret relative dates in Asia/Tokyo and convert them to YYYY-MM-DD before passing due dates to Linear.",
    "The Linear tools already target the configured workspace and team. Do not ask for workspace, team, or API credentials.",
    "Keep public Slack replies short. Do not expose tool logs or raw shell output unless the user asks.",
    "For reviews and heartbeat-style summaries, prefer one concrete follow-up request over broad list-making.",
  ].join("\n");
}

function currentDateInJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sanitizeSessionSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "default";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
}

function clampConfidence(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entryValue]) => [key, typeof entryValue === "string" ? entryValue.trim() : ""] as const)
    .filter(([, entryValue]) => entryValue.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeResearchNextActions(value: unknown): ResearchNextAction[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === "string") {
        const title = item.trim();
        return title
          ? {
              title,
              purpose: "",
              confidence: 0.5,
            } satisfies ResearchNextAction
          : undefined;
      }
      if (!item || typeof item !== "object") return undefined;

      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (!title) return undefined;

      return {
        title,
        purpose: typeof record.purpose === "string" ? record.purpose.trim() : "",
        ownerHint: typeof record.ownerHint === "string" && record.ownerHint.trim() ? record.ownerHint.trim() : undefined,
        confidence: clampConfidence(record.confidence, 0.5),
      } satisfies ResearchNextAction;
    })
    .filter((item): item is ResearchNextAction => Boolean(item))
    .slice(0, 8);
}

const optionalDateSchema = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional();

const taskPlanningChildSchema = z.object({
  title: z.string().trim().min(1),
  kind: z.enum(["execution", "research"]).default("execution"),
  dueDate: optionalDateSchema,
  assigneeHint: z.union([z.string().trim().min(1), z.null()]).optional(),
});

const taskPlanningClarifySchema = z.object({
  action: z.literal("clarify"),
  clarificationQuestion: z.string().trim().min(1),
  clarificationReasons: z.array(z.enum(["scope", "due_date", "execution_plan"])).default([]),
});

const taskPlanningCreateSchema = z.object({
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

const taskPlanningSchema = z.union([taskPlanningClarifySchema, taskPlanningCreateSchema]);

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return undefined;
}

function normalizeResearchSynthesisResult(value: unknown): ResearchSynthesisResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const findings = normalizeStringList(record.findings);
  const uncertainties = normalizeStringList(record.uncertainties);
  const nextActions = normalizeResearchNextActions(record.nextActions);

  if (findings.length === 0 && uncertainties.length === 0 && nextActions.length === 0) {
    return undefined;
  }

  return {
    findings,
    uncertainties,
    nextActions,
  };
}

export function parseResearchSynthesisReply(reply: string): ResearchSynthesisResult {
  const jsonText = extractJsonObject(reply);
  if (jsonText) {
    try {
      const parsed = normalizeResearchSynthesisResult(JSON.parse(jsonText));
      if (parsed) return parsed;
    } catch {
      // Fall back to line-based parsing below.
    }
  }

  const lines = reply
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*・•]\s*/, "").trim());

  const nextActions = lines
    .filter((line) => /(確認|修正|対応|実装|調査|整理|洗い出し|作成|更新|共有|再現|検証|比較)/.test(line))
    .slice(0, 5)
    .map((title) => ({
      title,
      purpose: "",
      confidence: 0.4,
    }));

  return {
    findings: lines.slice(0, 3),
    uncertainties: [],
    nextActions,
  };
}

export function parseTaskPlanningReply(reply: string): TaskPlanningResult {
  const jsonText = extractJsonObject(reply);
  if (!jsonText) {
    throw new Error("Task planner reply did not contain a JSON object");
  }

  const parsed = taskPlanningSchema.parse(JSON.parse(jsonText));
  if (parsed.action === "clarify") {
    return {
      action: "clarify",
      clarificationQuestion: parsed.clarificationQuestion,
      clarificationReasons: parsed.clarificationReasons,
    };
  }

  return {
    action: "create",
    planningReason: parsed.planningReason,
    parentTitle: parsed.parentTitle ?? undefined,
    parentDueDate: parsed.parentDueDate ?? undefined,
    children: parsed.children.map((child) => ({
      title: child.title,
      kind: child.kind,
      dueDate: child.dueDate ?? undefined,
      assigneeHint: child.assigneeHint ?? undefined,
    })),
  };
}

export function buildResearchSynthesisPrompt(input: ResearchSynthesisInput): string {
  return [
    "Summarize the following collected research evidence for a Slack-first execution manager.",
    "Reply with a single JSON object only.",
    'Use exactly this schema: {"findings": string[], "uncertainties": string[], "nextActions": [{"title": string, "purpose": string, "ownerHint"?: string, "confidence": number}]}.',
    "Keep all strings in Japanese.",
    "findings should be concrete observations grounded in the provided evidence.",
    "uncertainties should capture what is still unclear or needs confirmation.",
    "nextActions should contain only concrete executable task candidates, not questions.",
    "Only include nextActions when they are specific enough to become Linear child issues.",
    "Each nextActions item must include a concise title, a short purpose, and a confidence between 0 and 1.",
    "Do not repeat raw evidence verbatim when a short synthesis is enough.",
    "",
    "Research request context:",
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- taskTitle: ${input.taskTitle}`,
    `- currentDateJst: ${currentDateInJst()}`,
    "",
    "Source message:",
    input.sourceMessage || "(none)",
    "",
    "Slack thread context:",
    input.slackThreadSummary || "- none",
    "",
    "Recent channel context:",
    input.recentChannelSummary || "- none",
    "",
    "Related Linear issues:",
    input.relatedIssuesSummary || "- none",
    "",
    "Web evidence:",
    input.webSummary || "- none",
  ].join("\n");
}

export function buildTaskPlanningPrompt(input: TaskPlanningInput): string {
  return [
    "Plan how to register the following Slack request as Linear work.",
    "Reply with a single JSON object only.",
    'Use one of these schemas exactly:',
    '{"action":"clarify","clarificationQuestion":string,"clarificationReasons":["scope"|"due_date"|"execution_plan"]}',
    '{"action":"create","planningReason":"single-issue"|"complex-request"|"research-first","parentTitle":string|null,"parentDueDate":"YYYY-MM-DD"|null,"children":[{"title":string,"kind":"execution"|"research","dueDate":"YYYY-MM-DD"|null,"assigneeHint":string|null}]}',
    "Keep all strings in Japanese.",
    "Use clarify only when the request still lacks enough information to create reliable Linear work.",
    "clarificationQuestion must be exactly one concise follow-up question.",
    "For single-issue, set parentTitle to null and return exactly one child.",
    "For complex-request, return a concise parent title and execution-sized child tasks.",
    "For research-first, return a non-research parent title and at least one child with kind research.",
    "Normalize status-like phrases into actionable titles.",
    'Example normalization: "契約書のドラフト版の作成依頼済み" -> "ドラフト作成".',
    'Example normalization: "ドラフト版作成後、OPT 田平さんに確認依頼する必要あり" -> "OPT 田平さんへ契約書確認依頼".',
    "Preserve explicit assignee names in assigneeHint when they are given.",
    "Do not invent due dates or assignees. Use null or omit when unknown.",
    `Current date in Asia/Tokyo: ${input.currentDate}`,
    "",
    "Context:",
    `- originalRequest: ${input.originalRequest}`,
    `- latestUserMessage: ${input.latestUserMessage}`,
    `- combinedRequest: ${input.combinedRequest}`,
    `- previousClarificationQuestion: ${input.clarificationQuestion ?? "(none)"}`,
  ].join("\n");
}

function normalizeFollowupResolutionResult(value: unknown): FollowupResolutionResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.answered !== "boolean") return undefined;

  return {
    answered: record.answered,
    answerKind: typeof record.answerKind === "string" && record.answerKind.trim() ? record.answerKind.trim() : undefined,
    confidence: clampConfidence(record.confidence, record.answered ? 0.7 : 0.3),
    extractedFields: normalizeStringRecord(record.extractedFields),
    reasoningSummary: typeof record.reasoningSummary === "string" && record.reasoningSummary.trim()
      ? record.reasoningSummary.trim()
      : undefined,
  };
}

export function parseFollowupResolutionReply(reply: string): FollowupResolutionResult {
  const jsonText = extractJsonObject(reply);
  if (jsonText) {
    try {
      const parsed = normalizeFollowupResolutionResult(JSON.parse(jsonText));
      if (parsed) return parsed;
    } catch {
      // Fall through to the conservative unresolved result below.
    }
  }

  return {
    answered: false,
    confidence: 0,
    reasoningSummary: "follow-up resolution reply could not be parsed",
  };
}

export function buildFollowupResolutionPrompt(input: FollowupResolutionInput): string {
  return [
    "Assess whether the Slack reply sufficiently answers an open execution-manager follow-up request.",
    "Reply with a single JSON object only.",
    'Use exactly this schema: {"answered": boolean, "answerKind": string, "confidence": number, "extractedFields": {"assignee"?: string, "dueDate"?: string, "status"?: string, "nextAction"?: string, "nextUpdate"?: string, "blockedReason"?: string, "waitingOn"?: string, "resumeCondition"?: string}, "reasoningSummary": string}.',
    "Keep reasoningSummary concise and in Japanese.",
    "Only set answered=true if the reply actually satisfies the requested follow-up.",
    "For requestKind=status, expect progress, next action, and next update timing when possible.",
    "For requestKind=blocked-details, expect blocked reason, waiting party, and resume condition.",
    "For requestKind=owner, extract exactly one assignee name if present.",
    "For requestKind=due-date, extract exactly one dueDate in YYYY-MM-DD if present.",
    `issueId: ${input.issueId}`,
    `issueTitle: ${input.issueTitle}`,
    `requestKind: ${input.requestKind}`,
    `requestText: ${input.requestText}`,
    `acceptableAnswerHint: ${input.acceptableAnswerHint ?? "(none)"}`,
    "Slack reply:",
    input.responseText,
  ].join("\n");
}

export function buildAgentPrompt(
  input: AgentInput,
  config: AppConfig,
  paths: ThreadPaths,
  context?: ThreadPromptContext,
): string {
  const attachmentLines =
    input.attachments.length > 0
      ? input.attachments
          .map((attachment) => `- ${attachment.name}: ${relative(paths.rootDir, attachment.storedPath)}`)
          .join("\n")
      : "- none";

  const threadContextLines = context
    ? [
        `- lastResolvedIssueId: ${context.lastResolvedIssueId ?? "none"}`,
        `- parentIssueId: ${context.parentIssueId ?? "none"}`,
        `- childIssueIds: ${context.childIssueIds.length > 0 ? context.childIssueIds.join(", ") : "none"}`,
        `- duplicateReuse: ${context.duplicateReuse ? "yes" : "no"}`,
        `- pendingClarification: ${context.pendingClarification ? "yes" : "no"}`,
        `- preferredIssueIds: ${context.preferredIssueIds.length > 0 ? context.preferredIssueIds.join(", ") : "none"}`,
      ]
    : ["- none"];

  const candidateIssueLines = context && context.candidateIssues.length > 0
    ? context.candidateIssues.map((issue) => `- ${issue.issueId}${issue.title ? ` / ${issue.title}` : ""}`)
    : ["- none"];

  return [
    "Slack message metadata:",
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- userId: ${input.userId}`,
    `- intentHint: ${input.intent}`,
    `- fixedLinearWorkspace: ${config.linearWorkspace}`,
    `- fixedLinearTeamKey: ${config.linearTeamKey}`,
    `- currentDateJst: ${currentDateInJst()}`,
    "",
    "Attachments:",
    attachmentLines,
    "",
    "Thread-linked issue context:",
    ...threadContextLines,
    "",
    "Candidate issue summaries:",
    ...candidateIssueLines,
    "",
    "Current user message:",
    input.text || "(no text, attachments only)",
  ].join("\n");
}

function buildSystemPromptInput(input: SystemAgentInput, config: AppConfig): string {
  const metadataLines = Object.entries(input.metadata ?? {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");

  return [
    "System automation context:",
    `- runKind: ${input.kind}`,
    `- channelId: ${input.channelId}`,
    `- fixedLinearWorkspace: ${config.linearWorkspace}`,
    `- fixedLinearTeamKey: ${config.linearTeamKey}`,
    `- currentDateJst: ${currentDateInJst()}`,
    ...(metadataLines ? ["", "Metadata:", metadataLines] : []),
    "",
    "Task:",
    input.text,
  ].join("\n");
}

function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;

    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
            return String(item.text);
          }
          return "";
        })
        .join("")
        .trim();
    }
  }

  return "";
}

async function runIsolatedPromptTurn(
  config: AppConfig,
  paths: ThreadPaths,
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
): Promise<string> {
  const shared = await getSharedRuntime(config);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 1 },
  });

  const loader = new DefaultResourceLoader({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const sessionFile = join(paths.scratchDir, `isolated-${sanitizeSessionSuffix(sessionSuffix)}.jsonl`);
  const sessionManager = SessionManager.open(sessionFile, paths.rootDir);
  const { session } = await createAgentSession({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    model: shared.model,
    thinkingLevel: "minimal",
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    customTools: [],
  });

  const deltas: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(prompt);
    await session.agent.waitForIdle();
    const text = deltas.join("").trim() || extractAssistantText(session.messages as unknown[]);
    if (!text) {
      throw new Error("Agent finished without producing a research synthesis reply");
    }
    return text;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

function buildThreadRuntimeKey(paths: ThreadPaths): string {
  return paths.sessionFile;
}

async function getSharedRuntime(config: AppConfig): Promise<SharedRuntime> {
  if (!sharedRuntimePromise) {
    sharedRuntimePromise = (async () => {
      const agentDir = join(config.workspaceDir, ".pi", "agent");
      const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
      if (config.anthropicApiKey) {
        authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
      }

      const modelRegistry = new ModelRegistry(authStorage);
      const requestedModel = modelRegistry.find("anthropic", config.botModel);
      const availableModels = await modelRegistry.getAvailable();
      const fallbackModel = availableModels.find((model) => model.provider === "anthropic");
      const model = requestedModel ?? fallbackModel;

      if (!model) {
        throw new Error(`Unable to resolve bot model "${config.botModel}" for Anthropic`);
      }

      return {
        agentDir,
        authStorage,
        modelRegistry,
        model,
      };
    })().catch((error) => {
      sharedRuntimePromise = undefined;
      throw error;
    });
  }

  return sharedRuntimePromise;
}

async function createThreadRuntime(config: AppConfig, paths: ThreadPaths): Promise<ThreadRuntime> {
  const shared = await getSharedRuntime(config);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 1 },
  });

  const loader = new DefaultResourceLoader({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => buildSystemPrompt(config),
  });
  await loader.reload();

  const sessionManager = SessionManager.open(paths.sessionFile, paths.rootDir);
  const { session } = await createAgentSession({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    model: shared.model,
    thinkingLevel: "minimal",
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [createReadTool(paths.rootDir)],
    customTools: createLinearCustomTools(config),
  });

  return {
    session,
    lastUsedAt: Date.now(),
  };
}

async function getOrCreateThreadRuntime(config: AppConfig, paths: ThreadPaths): Promise<ThreadRuntime> {
  const key = buildThreadRuntimeKey(paths);
  const existing = threadRuntimePromises.get(key);

  if (existing) {
    const runtime = await existing;
    runtime.lastUsedAt = Date.now();
    return runtime;
  }

  const pending = createThreadRuntime(config, paths).catch((error) => {
    threadRuntimePromises.delete(key);
    throw error;
  });
  threadRuntimePromises.set(key, pending);

  const runtime = await pending;
  runtime.lastUsedAt = Date.now();
  return runtime;
}

async function disposeThreadRuntime(key: string): Promise<void> {
  const pending = threadRuntimePromises.get(key);
  if (!pending) return;

  threadRuntimePromises.delete(key);
  try {
    const runtime = await pending;
    runtime.session.dispose();
  } catch {
    // Ignore startup failures while cleaning up stale runtime entries.
  }
}

export async function disposeIdleThreadRuntimes(maxIdleMs = DEFAULT_THREAD_IDLE_MS): Promise<void> {
  const now = Date.now();
  const staleKeys: string[] = [];

  for (const [key, pending] of threadRuntimePromises.entries()) {
    try {
      const runtime = await pending;
      if (now - runtime.lastUsedAt >= maxIdleMs) {
        staleKeys.push(key);
      }
    } catch {
      staleKeys.push(key);
    }
  }

  await Promise.all(staleKeys.map((key) => disposeThreadRuntime(key)));
}

export async function disposeAllThreadRuntimes(): Promise<void> {
  await Promise.all(Array.from(threadRuntimePromises.keys()).map((key) => disposeThreadRuntime(key)));
}

export async function runAgentTurn(config: AppConfig, paths: ThreadPaths, input: AgentInput): Promise<string> {
  const context = await loadThreadPromptContext(config, input);
  return runPromptTurn(config, paths, buildAgentPrompt(input, config, paths, context));
}

export async function runSystemTurn(config: AppConfig, paths: ThreadPaths, input: SystemAgentInput): Promise<string> {
  return runPromptTurn(config, paths, buildSystemPromptInput(input, config));
}

export async function runResearchSynthesisTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ResearchSynthesisInput,
): Promise<ResearchSynthesisResult> {
  const reply = await runIsolatedPromptTurn(
    config,
    paths,
    buildResearchSynthesisPrompt(input),
    [
      "You are a research synthesis helper for a Slack-first execution manager.",
      "Reply with valid JSON only.",
      "The JSON schema is {\"findings\": string[], \"uncertainties\": string[], \"nextActions\": [{\"title\": string, \"purpose\": string, \"ownerHint\"?: string, \"confidence\": number}]}.",
      "Keep output concise, grounded in the provided evidence, and in Japanese.",
      "nextActions must be concrete executable task candidates, not vague summaries.",
      "Use confidence between 0 and 1.",
    ].join("\n"),
    input.taskKey ?? `${input.channelId}-${input.rootThreadTs}-research-synthesis`,
  );

  return parseResearchSynthesisReply(reply);
}

export async function runTaskPlanningTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: TaskPlanningInput,
): Promise<TaskPlanningResult> {
  const reply = await runIsolatedPromptTurn(
    config,
    paths,
    buildTaskPlanningPrompt(input),
    [
      "You are a task intake planner for a Slack-first execution manager.",
      "Reply with valid JSON only.",
      "Convert ambiguous or status-like request text into clean Linear issue titles.",
      "Prefer concise, execution-ready task titles in Japanese.",
      "When enough detail exists, do not ask a clarification question.",
    ].join("\n"),
    input.taskKey ?? `${input.channelId}-${input.rootThreadTs}-task-planning`,
  );

  return parseTaskPlanningReply(reply);
}

export async function runFollowupResolutionTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: FollowupResolutionInput,
): Promise<FollowupResolutionResult> {
  const reply = await runIsolatedPromptTurn(
    config,
    paths,
    buildFollowupResolutionPrompt(input),
    [
      "You are a follow-up resolution helper for a Slack-first execution manager.",
      "Reply with valid JSON only.",
      "Decide whether the Slack reply actually answers the requested follow-up.",
      "Be strict: mentioning progress without satisfying the request must stay unanswered.",
    ].join("\n"),
    input.taskKey ?? `${input.issueId}-followup-resolution`,
  );

  return parseFollowupResolutionReply(reply);
}

async function runPromptTurn(config: AppConfig, paths: ThreadPaths, prompt: string): Promise<string> {
  const runtimeKey = buildThreadRuntimeKey(paths);
  const runtime = await getOrCreateThreadRuntime(config, paths);
  const messageCountBefore = runtime.session.messages.length;
  const deltas: string[] = [];
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });

  try {
    await runtime.session.prompt(prompt);
    await runtime.session.agent.waitForIdle();

    const newMessages = (runtime.session.messages as unknown[]).slice(messageCountBefore);
    const text = deltas.join("").trim() || extractAssistantText(newMessages);
    if (!text) {
      throw new Error("Agent finished without producing a reply");
    }

    runtime.lastUsedAt = Date.now();

    const lastReplyPath = join(paths.scratchDir, "last-reply.txt");
    await writeFile(lastReplyPath, `${text}\n`, "utf8");
    return text;
  } catch (error) {
    await disposeThreadRuntime(runtimeKey);
    throw error;
  } finally {
    unsubscribe();
    runtime.lastUsedAt = Date.now();
  }
}
