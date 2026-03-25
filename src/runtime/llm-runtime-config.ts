import { join } from "node:path";
import { type StreamFn, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { AuthStorage, ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { AppConfig, BotThinkingLevel } from "../lib/config.js";

export interface LlmRuntimeConfig {
  configuredModel: string;
  configuredThinkingLevel: BotThinkingLevel;
  effectiveThinkingLevel: ThinkingLevel;
  maxOutputTokens?: number;
  retryMaxRetries: number;
}

export interface LlmResolvedModelSummary {
  provider: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface LlmAuthSourceSummary {
  provider: string;
  source: "runtime-override" | "auth-storage" | "unresolved";
  note: string;
}

export interface AnthropicPayloadPreview {
  model: string;
  max_tokens: {
    request: number;
    base: number;
    source: "configured" | "library/provider derived";
  };
  thinking:
    | { mode: "disabled" }
    | { mode: "budget"; level: ThinkingLevel; budget_tokens: number }
    | { mode: "adaptive"; level: ThinkingLevel; effort?: string };
  systemPresent: boolean;
  toolsPresent: boolean;
  cacheRetention: {
    configured: null;
    effective: "short" | "long";
  };
  temperature: {
    configured: null;
    sent: boolean;
    reason: string;
  };
  sessionId: {
    suppliedByAgent: boolean;
    forwardedToProvider: boolean;
    note: string;
  };
}

export interface GenericPayloadPreview {
  model: string;
  maxTokens: {
    request: number;
    source: "configured" | "library/provider derived";
  };
  systemPresent: boolean;
  toolsPresent: boolean;
  note: string;
}

export interface LlmDiagnostics {
  configured: {
    model: string;
    thinkingLevel: BotThinkingLevel;
    maxOutputTokens: number | null;
    retryMaxRetries: number;
  };
  resolvedModel: LlmResolvedModelSummary;
  authSource: LlmAuthSourceSummary;
  effective: {
    thread: {
      thinkingLevel: ThinkingLevel;
      maxOutputTokens: number | null;
      retryMaxRetries: number;
      systemPresent: true;
      toolsPresent: true;
    };
    isolated: {
      thinkingLevel: ThinkingLevel;
      maxOutputTokens: number | null;
      retryMaxRetries: number;
      systemPresent: true;
      toolsPresent: false;
    };
  };
  providerPayloadPreview: {
    provider: string;
    thread: AnthropicPayloadPreview | GenericPayloadPreview;
    isolated: AnthropicPayloadPreview | GenericPayloadPreview;
  };
  notes: {
    sessionId: string;
    temperature: string;
    cacheRetention: string;
  };
}

export interface ResolvedLlmRuntimeDependencies {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Model<any>;
  runtimeConfig: LlmRuntimeConfig;
  authSource: LlmAuthSourceSummary;
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6") || modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

function clampReasoning(level: ThinkingLevel): Exclude<ThinkingLevel, "xhigh"> {
  return level === "xhigh" ? "high" : level;
}

function mapThinkingLevelToEffort(level: ThinkingLevel, modelId: string): string | undefined {
  if (!supportsAdaptiveThinking(modelId)) return undefined;
  switch (level) {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") ? "max" : "high";
    default:
      return undefined;
  }
}

function resolveEffectiveThinkingLevel(configuredThinkingLevel: BotThinkingLevel, model: Model<any>): ThinkingLevel {
  return model.reasoning ? configuredThinkingLevel : "off";
}

function resolveBaseMaxTokens(model: Model<any>, maxOutputTokens?: number): {
  base: number;
  source: "configured" | "library/provider derived";
} {
  if (maxOutputTokens !== undefined) {
    return {
      base: maxOutputTokens,
      source: "configured",
    };
  }
  return {
    base: Math.min(model.maxTokens, 32000),
    source: "library/provider derived",
  };
}

function adjustAnthropicMaxTokensForThinking(
  baseMaxTokens: number,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
): { request: number; budgetTokens: number } {
  const defaultBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const level = clampReasoning(reasoningLevel) as keyof typeof defaultBudgets;
  const minOutputTokens = 1024;
  let budgetTokens = defaultBudgets[level];
  const request = Math.min(baseMaxTokens + budgetTokens, modelMaxTokens);
  if (request <= budgetTokens) {
    budgetTokens = Math.max(0, request - minOutputTokens);
  }
  return {
    request,
    budgetTokens,
  };
}

function buildAnthropicPayloadPreview(
  model: Model<any>,
  runtimeConfig: LlmRuntimeConfig,
  toolsPresent: boolean,
): AnthropicPayloadPreview {
  const { base, source } = resolveBaseMaxTokens(model, runtimeConfig.maxOutputTokens);
  const effectiveThinkingLevel = runtimeConfig.effectiveThinkingLevel;
  const cacheRetention = (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short") as "short" | "long";
  if (effectiveThinkingLevel === "off" || !model.reasoning) {
    return {
      model: model.id,
      max_tokens: {
        request: base,
        base,
        source,
      },
      thinking: { mode: "disabled" },
      systemPresent: true,
      toolsPresent,
      cacheRetention: {
        configured: null,
        effective: cacheRetention,
      },
      temperature: {
        configured: null,
        sent: false,
        reason: "temperature is not configured by the repo",
      },
      sessionId: {
        suppliedByAgent: true,
        forwardedToProvider: false,
        note: "sessionId is passed to the agent session but the Anthropic adapter does not currently forward it",
      },
    };
  }

  if (supportsAdaptiveThinking(model.id)) {
    return {
      model: model.id,
      max_tokens: {
        request: base,
        base,
        source,
      },
      thinking: {
        mode: "adaptive",
        level: effectiveThinkingLevel,
        effort: mapThinkingLevelToEffort(effectiveThinkingLevel, model.id),
      },
      systemPresent: true,
      toolsPresent,
      cacheRetention: {
        configured: null,
        effective: cacheRetention,
      },
      temperature: {
        configured: null,
        sent: false,
        reason: "Anthropic does not send temperature when thinking is enabled",
      },
      sessionId: {
        suppliedByAgent: true,
        forwardedToProvider: false,
        note: "sessionId is passed to the agent session but the Anthropic adapter does not currently forward it",
      },
    };
  }

  const adjusted = adjustAnthropicMaxTokensForThinking(base, model.maxTokens, effectiveThinkingLevel);
  return {
    model: model.id,
    max_tokens: {
      request: adjusted.request,
      base,
      source,
    },
    thinking: {
      mode: "budget",
      level: effectiveThinkingLevel,
      budget_tokens: adjusted.budgetTokens,
    },
    systemPresent: true,
    toolsPresent,
    cacheRetention: {
      configured: null,
      effective: cacheRetention,
    },
    temperature: {
      configured: null,
      sent: false,
      reason: "Anthropic does not send temperature when thinking is enabled",
    },
    sessionId: {
      suppliedByAgent: true,
      forwardedToProvider: false,
      note: "sessionId is passed to the agent session but the Anthropic adapter does not currently forward it",
    },
  };
}

function buildGenericPayloadPreview(
  model: Model<any>,
  runtimeConfig: LlmRuntimeConfig,
  toolsPresent: boolean,
): GenericPayloadPreview {
  const { base, source } = resolveBaseMaxTokens(model, runtimeConfig.maxOutputTokens ?? model.maxTokens);
  return {
    model: model.id,
    maxTokens: {
      request: base,
      source,
    },
    systemPresent: true,
    toolsPresent,
    note: `Provider-specific payload preview is not implemented for ${model.provider}`,
  };
}

function summarizeResolvedModel(model: Model<any>): LlmResolvedModelSummary {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function resolveLlmRuntimeConfig(config: Pick<AppConfig, "botModel" | "botThinkingLevel" | "botMaxOutputTokens" | "botRetryMaxRetries">, model: Model<any>): LlmRuntimeConfig {
  return {
    configuredModel: config.botModel,
    configuredThinkingLevel: config.botThinkingLevel,
    effectiveThinkingLevel: resolveEffectiveThinkingLevel(config.botThinkingLevel, model),
    maxOutputTokens: config.botMaxOutputTokens,
    retryMaxRetries: config.botRetryMaxRetries,
  };
}

export function createLlmSettingsManager(runtimeConfig: LlmRuntimeConfig): SettingsManager {
  return SettingsManager.inMemory({
    defaultThinkingLevel: runtimeConfig.effectiveThinkingLevel,
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: runtimeConfig.retryMaxRetries },
  });
}

export function wrapStreamFnWithMaxOutputTokens(streamFn: StreamFn, maxOutputTokens?: number): StreamFn {
  if (maxOutputTokens === undefined) {
    return streamFn;
  }
  return (model, context, options) => streamFn(model, context, {
    ...(options ?? {}),
    maxTokens: maxOutputTokens,
  });
}

export async function resolveLlmRuntimeDependencies(config: AppConfig): Promise<ResolvedLlmRuntimeDependencies> {
  const agentDir = join(config.workspaceDir, ".pi", "agent");
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  if (config.anthropicApiKey) {
    authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
  }

  const modelRegistry = new ModelRegistry(authStorage);
  const requestedModel = modelRegistry.find("anthropic", config.botModel);
  const availableModels = await modelRegistry.getAvailable();
  const fallbackModel = availableModels.find((candidate) => candidate.provider === "anthropic");
  const model = requestedModel ?? fallbackModel;

  if (!model) {
    throw new Error(`Unable to resolve bot model "${config.botModel}" for Anthropic`);
  }

  const authSource: LlmAuthSourceSummary = config.anthropicApiKey
    ? {
      provider: model.provider,
      source: "runtime-override",
      note: "Using ANTHROPIC_API_KEY runtime override",
    }
    : authStorage.has(model.provider)
      ? {
        provider: model.provider,
        source: "auth-storage",
        note: "Using stored credential from auth.json",
      }
      : {
        provider: model.provider,
        source: "unresolved",
        note: "No runtime override or stored credential detected",
      };

  return {
    agentDir,
    authStorage,
    modelRegistry,
    model,
    runtimeConfig: resolveLlmRuntimeConfig(config, model),
    authSource,
  };
}

export function buildLlmDiagnostics(args: {
  config: AppConfig;
  model: Model<any>;
  runtimeConfig: LlmRuntimeConfig;
  authSource: LlmAuthSourceSummary;
}): LlmDiagnostics {
  const providerPayloadPreview = args.model.provider === "anthropic"
    ? {
      provider: args.model.provider,
      thread: buildAnthropicPayloadPreview(args.model, args.runtimeConfig, true),
      isolated: buildAnthropicPayloadPreview(args.model, args.runtimeConfig, false),
    }
    : {
      provider: args.model.provider,
      thread: buildGenericPayloadPreview(args.model, args.runtimeConfig, true),
      isolated: buildGenericPayloadPreview(args.model, args.runtimeConfig, false),
    };

  return {
    configured: {
      model: args.config.botModel,
      thinkingLevel: args.config.botThinkingLevel,
      maxOutputTokens: args.config.botMaxOutputTokens ?? null,
      retryMaxRetries: args.config.botRetryMaxRetries,
    },
    resolvedModel: summarizeResolvedModel(args.model),
    authSource: args.authSource,
    effective: {
      thread: {
        thinkingLevel: args.runtimeConfig.effectiveThinkingLevel,
        maxOutputTokens: args.runtimeConfig.maxOutputTokens ?? null,
        retryMaxRetries: args.runtimeConfig.retryMaxRetries,
        systemPresent: true,
        toolsPresent: true,
      },
      isolated: {
        thinkingLevel: args.runtimeConfig.effectiveThinkingLevel,
        maxOutputTokens: args.runtimeConfig.maxOutputTokens ?? null,
        retryMaxRetries: args.runtimeConfig.retryMaxRetries,
        systemPresent: true,
        toolsPresent: false,
      },
    },
    providerPayloadPreview,
    notes: {
      sessionId: "SessionManager supplies sessionId to the agent, but the Anthropic adapter does not currently forward it.",
      temperature: args.runtimeConfig.effectiveThinkingLevel === "off"
        ? "Temperature is currently unset by the repo."
        : "Temperature is currently unset by the repo and Anthropic omits it when thinking is enabled.",
      cacheRetention: "cacheRetention is not configured by the repo. Anthropic currently defaults to short/ephemeral caching.",
    },
  };
}

export async function buildLlmDiagnosticsFromConfig(config: AppConfig): Promise<LlmDiagnostics> {
  const dependencies = await resolveLlmRuntimeDependencies(config);
  return buildLlmDiagnostics({
    config,
    model: dependencies.model,
    runtimeConfig: dependencies.runtimeConfig,
    authSource: dependencies.authSource,
  });
}
