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
import type { AppConfig } from "./config.js";
import { createLinearCustomTools } from "./linear-tools.js";
import type { TaskIntent } from "./slack.js";
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

function buildSystemPrompt(config: AppConfig): string {
  return [
    "You are a Japanese Slack execution manager for task management.",
    "Reply in Japanese.",
    "Linear is the only system of record for tracked tasks.",
    "Do not use or invent any internal todo list.",
    "Treat the allowed Slack channel as a control room for task execution.",
    "Create, search, inspect, assign, and update Linear issues when task progression requires it.",
    "Prefer checking for existing work before creating new issues.",
    "For larger requests, create a parent issue and execution-sized child issues.",
    "Use owner hints from the conversation when assigning work, but do not ask for API keys or workspace/team identifiers.",
    "If the request is ambiguous, ask exactly one concise follow-up question before taking action.",
    "Do not ask the user for API keys. Slack and Linear credentials are already configured in the environment.",
    "Use the dedicated Linear tools for tracked task work.",
    `The fixed Linear workspace slug is ${config.linearWorkspace}.`,
    `The fixed Linear team key is ${config.linearTeamKey}.`,
    "Interpret relative dates in Asia/Tokyo and convert them to YYYY-MM-DD before passing due dates to Linear.",
    "The Linear tools already target the configured workspace and team. Do not ask for workspace, team, or API credentials.",
    "Keep public Slack replies short. Do not expose tool logs or raw shell output unless the user asks.",
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

function buildPrompt(input: AgentInput, config: AppConfig, paths: ThreadPaths): string {
  const attachmentLines =
    input.attachments.length > 0
      ? input.attachments
          .map((attachment) => `- ${attachment.name}: ${relative(paths.rootDir, attachment.storedPath)}`)
          .join("\n")
      : "- none";

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
  return runPromptTurn(config, paths, buildPrompt(input, config, paths));
}

export async function runSystemTurn(config: AppConfig, paths: ThreadPaths, input: SystemAgentInput): Promise<string> {
  return runPromptTurn(config, paths, buildSystemPromptInput(input, config));
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
