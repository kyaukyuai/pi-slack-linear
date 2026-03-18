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
import {
  runFollowupResolutionTurnWithExecutor,
  type FollowupResolutionInput,
  type FollowupResolutionResult,
} from "../planners/followup-resolution/index.js";
import {
  runResearchSynthesisTurnWithExecutor,
  type ResearchNextAction,
  type ResearchSynthesisInput,
  type ResearchSynthesisResult,
} from "../planners/research-synthesis/index.js";
import {
  runTaskPlanningTurnWithExecutor,
  type TaskPlanningInput,
  type TaskPlanningResult,
} from "../planners/task-intake/index.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { IntakeLedgerEntry } from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { AppConfig } from "./config.js";
import { getLinearIssue } from "./linear.js";
import { createLinearCustomTools } from "./linear-tools.js";
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

export {
  buildFollowupResolutionPrompt,
  parseFollowupResolutionReply,
  type FollowupResolutionInput,
  type FollowupResolutionResult,
} from "../planners/followup-resolution/index.js";

export {
  buildResearchSynthesisPrompt,
  parseResearchSynthesisReply,
  type ResearchNextAction,
  type ResearchSynthesisInput,
  type ResearchSynthesisResult,
} from "../planners/research-synthesis/index.js";

export {
  buildTaskPlanningPrompt,
  parseTaskPlanningReply,
  type TaskPlanningChild,
  type TaskPlanningInput,
  type TaskPlanningResult,
  type TaskPlanningResultClarify,
  type TaskPlanningResultCreate,
} from "../planners/task-intake/index.js";

interface SharedRuntime {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Awaited<ReturnType<ModelRegistry["getAvailable"]>>[number];
  managerRepositories: ManagerRepositories;
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

async function loadThreadPromptContext(
  config: AppConfig,
  input: AgentInput,
  managerRepositories: Pick<ManagerRepositories, "intake">,
): Promise<ThreadPromptContext | undefined> {
  const ledger = await managerRepositories.intake.load().catch(() => []);
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
        managerRepositories: createFileBackedManagerRepositories(buildSystemPaths(config.workspaceDir)),
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
    customTools: createLinearCustomTools(config, shared.managerRepositories),
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
  const shared = await getSharedRuntime(config);
  const context = await loadThreadPromptContext(config, input, shared.managerRepositories);
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
  return runResearchSynthesisTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
}

export async function runTaskPlanningTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: TaskPlanningInput,
): Promise<TaskPlanningResult> {
  return runTaskPlanningTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
}

export async function runFollowupResolutionTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: FollowupResolutionInput,
): Promise<FollowupResolutionResult> {
  return runFollowupResolutionTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
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
