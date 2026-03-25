import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/lib/config.js";
import {
  buildLlmDiagnostics,
  buildLlmDiagnosticsFromConfig,
  createLlmSettingsManager,
  resolveLlmRuntimeConfig,
  wrapStreamFnWithMaxOutputTokens,
} from "../src/runtime/llm-runtime-config.js";

const baseConfig = (workspaceDir: string): AppConfig => ({
  slackAppToken: "xapp-test",
  slackBotToken: "xoxb-test",
  slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
  anthropicApiKey: "anthropic-test",
  linearApiKey: "lin_api_test",
  linearWorkspace: "kyaukyuai",
  linearTeamKey: "AIC",
  notionApiToken: undefined,
  notionAgendaParentPageId: undefined,
  botModel: "claude-sonnet-4-5",
  botThinkingLevel: "minimal",
  botMaxOutputTokens: undefined,
  botRetryMaxRetries: 1,
  workspaceDir,
  linearWebhookEnabled: false,
  linearWebhookPublicUrl: undefined,
  linearWebhookSecret: undefined,
  linearWebhookPort: 8787,
  linearWebhookPath: "/hooks/linear",
  heartbeatIntervalMin: 30,
  heartbeatActiveLookbackHours: 24,
  schedulerPollSec: 30,
  workgraphMaintenanceIntervalMin: 15,
  workgraphHealthWarnActiveEvents: 200,
  workgraphAutoCompactMaxActiveEvents: 500,
  logLevel: "info",
});

describe("llm runtime config", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates settings manager with configured retry settings", () => {
    const model = getModel("anthropic", "claude-sonnet-4-5");
    const runtimeConfig = resolveLlmRuntimeConfig({
      botModel: model.id,
      botThinkingLevel: "high",
      botMaxOutputTokens: 8192,
      botRetryMaxRetries: 0,
    }, model);

    const settingsManager = createLlmSettingsManager(runtimeConfig);

    expect(settingsManager.getRetrySettings().maxRetries).toBe(0);
    expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
  });

  it("injects maxTokens only when configured", async () => {
    const baseStreamFn = vi.fn(async (_model, _context, options) => options);
    const unwrapped = wrapStreamFnWithMaxOutputTokens(baseStreamFn, undefined);
    const wrapped = wrapStreamFnWithMaxOutputTokens(baseStreamFn, 4096);

    const passThroughOptions = await unwrapped({} as never, {} as never, { maxTokens: 1234 });
    const overriddenOptions = await wrapped({} as never, {} as never, { maxTokens: 1234 });

    expect(passThroughOptions).toMatchObject({ maxTokens: 1234 });
    expect(overriddenOptions).toMatchObject({ maxTokens: 4096 });
  });

  it("builds anthropic diagnostics with derived minimal thinking preview", () => {
    const model = getModel("anthropic", "claude-sonnet-4-5");
    const runtimeConfig = resolveLlmRuntimeConfig({
      botModel: model.id,
      botThinkingLevel: "minimal",
      botMaxOutputTokens: undefined,
      botRetryMaxRetries: 1,
    }, model);

    const diagnostics = buildLlmDiagnostics({
      config: baseConfig("/tmp/cogito-work-manager"),
      model,
      runtimeConfig,
      authSource: {
        provider: "anthropic",
        source: "runtime-override",
        note: "Using ANTHROPIC_API_KEY runtime override",
      },
    });

    expect(diagnostics.providerPayloadPreview.provider).toBe("anthropic");
    expect(diagnostics.providerPayloadPreview.thread).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: {
        base: 32000,
        request: 33024,
        source: "library/provider derived",
      },
      thinking: {
        mode: "budget",
        level: "minimal",
        budget_tokens: 1024,
      },
      toolsPresent: true,
    });
    expect(diagnostics.providerPayloadPreview.isolated).toMatchObject({
      toolsPresent: false,
    });
  });

  it("summarizes auth source without exposing secrets", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "llm-runtime-config-"));
    tempDirs.push(workspaceDir);

    const diagnostics = await buildLlmDiagnosticsFromConfig(baseConfig(workspaceDir));

    expect(diagnostics.authSource).toMatchObject({
      provider: "anthropic",
      source: "runtime-override",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("anthropic-test");
  });
});
