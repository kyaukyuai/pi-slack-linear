import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const managerMocks = vi.hoisted(() => ({
  handleManagerMessage: vi.fn(),
}));

const threadWorkspaceMocks = vi.hoisted(() => ({
  appendThreadLog: vi.fn(),
  buildThreadPaths: vi.fn((workspaceDir: string, channelId: string, threadTs: string) => ({
    rootDir: `${workspaceDir}/${channelId}/${threadTs}`,
    attachmentsDir: `${workspaceDir}/attachments`,
    scratchDir: `${workspaceDir}/scratch`,
  })),
  ensureThreadWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/manager.js", () => ({
  handleManagerMessage: managerMocks.handleManagerMessage,
}));

vi.mock("../src/lib/thread-workspace.js", () => ({
  appendThreadLog: threadWorkspaceMocks.appendThreadLog,
  buildThreadPaths: threadWorkspaceMocks.buildThreadPaths,
  ensureThreadWorkspace: threadWorkspaceMocks.ensureThreadWorkspace,
}));

function buildConfig() {
  return {
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    slackAllowedChannelIds: new Set(["C123"]),
    anthropicApiKey: "anthropic-test",
    linearApiKey: "lin_api_test",
    linearWorkspace: "kyaukyuai",
    linearTeamKey: "AIC",
    notionApiToken: undefined,
    notionAgendaParentPageId: undefined,
    botModel: "claude-sonnet-4-6",
    botThinkingLevel: "minimal" as const,
    botMaxOutputTokens: undefined,
    botRetryMaxRetries: 0,
    workspaceDir: "/tmp/cogito-runtime-test",
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
    logLevel: "info" as const,
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createWebClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "placeholder.123" }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      startStream: vi.fn().mockResolvedValue({ ts: "stream.123" }),
      appendStream: vi.fn().mockResolvedValue({}),
      stopStream: vi.fn().mockResolvedValue({}),
    },
  } as never;
}

function buildManagerResult(reply: string, intent: string) {
  return {
    handled: true,
    reply,
    diagnostics: {
      agent: {
        source: "agent",
        intent,
        toolCalls: [],
        proposalCount: 0,
        invalidProposalCount: 0,
        committedCommands: [],
        commitRejections: [],
        missingQuerySnapshot: false,
      },
    },
  };
}

async function flushQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("app runtime Slack streaming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    managerMocks.handleManagerMessage.mockReset();
    threadWorkspaceMocks.appendThreadLog.mockReset();
    threadWorkspaceMocks.buildThreadPaths.mockClear();
    threadWorkspaceMocks.ensureThreadWorkspace.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams an early read-only reply without posting the processing notice", async () => {
    vi.useRealTimers();
    const { createAppRuntimeHandlers } = await import("../src/runtime/app-runtime.js");
    const webClient = createWebClient();
    const logger = createLogger();

    managerMocks.handleManagerMessage.mockImplementation(async (...callArgs: any[]) => {
      const runtimeActions = callArgs[5];
      runtimeActions.managerAgentObserver?.onIntentReport({
        intent: "conversation",
        conversationKind: "casual",
        confidence: 0.91,
      });
      runtimeActions.managerAgentObserver?.onTextDelta("こんにちは");
      return buildManagerResult("こんにちは", "conversation");
    });

    const handlers = createAppRuntimeHandlers({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: { policy: { load: vi.fn() } } as never,
      linearEnv: {},
      slackTeamId: "T123",
      getManagerPolicy: () => ({ controlRoomChannelId: "CROOM" }) as never,
      setManagerPolicy: vi.fn(),
    });

    await handlers.handleSlackMessageEvent({
      channel: "C123",
      user: "U123",
      ts: "111.222",
      text: "こんにちは",
    }, "UBOT");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(webClient.chat.startStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      recipient_user_id: "U123",
      recipient_team_id: "T123",
      markdown_text: "こんにちは",
    });
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      text: "考え中...",
    });
    expect(webClient.chat.delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "placeholder.123",
    });
    expect(webClient.chat.stopStream).toHaveBeenCalledWith({
      channel: "C123",
      ts: "stream.123",
      markdown_text: undefined,
    });
    expect(webClient.chat.update).not.toHaveBeenCalled();
    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenCalledTimes(2);
    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: "assistant",
        text: "こんにちは",
      }),
    );
  });

  it("keeps mutable turns on the processing notice plus final update path", async () => {
    const { createAppRuntimeHandlers } = await import("../src/runtime/app-runtime.js");
    const webClient = createWebClient();
    const logger = createLogger();

    managerMocks.handleManagerMessage.mockImplementation(async (...callArgs: any[]) => {
      const runtimeActions = callArgs[5];
      runtimeActions.managerAgentObserver?.onIntentReport({
        intent: "update_completed",
        confidence: 0.95,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return buildManagerResult("AIC-65 を完了にしました。", "update_completed");
    });

    const handlers = createAppRuntimeHandlers({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: { policy: { load: vi.fn() } } as never,
      linearEnv: {},
      slackTeamId: "T123",
      getManagerPolicy: () => ({ controlRoomChannelId: "CROOM" }) as never,
      setManagerPolicy: vi.fn(),
    });

    await handlers.handleSlackMessageEvent({
      channel: "C123",
      user: "U123",
      ts: "111.333",
      text: "完了しました",
    }, "UBOT");
    await flushQueue();
    await vi.advanceTimersByTimeAsync(800);
    await flushQueue();
    await vi.runAllTimersAsync();
    await flushQueue();

    expect(webClient.chat.startStream).not.toHaveBeenCalled();
    expect(webClient.chat.delete).not.toHaveBeenCalled();
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.333",
      text: "考え中...",
    });
    expect(webClient.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "placeholder.123",
      text: "AIC-65 を完了にしました。",
      blocks: expect.any(Array),
    });
  });

  it("switches from placeholder to streaming when read-only intent arrives later", async () => {
    const { createAppRuntimeHandlers } = await import("../src/runtime/app-runtime.js");
    const webClient = createWebClient();
    const logger = createLogger();

    managerMocks.handleManagerMessage.mockImplementation(async (...callArgs: any[]) => {
      const runtimeActions = callArgs[5];
      await new Promise((resolve) => setTimeout(resolve, 1000));
      runtimeActions.managerAgentObserver?.onIntentReport({
        intent: "query",
        queryKind: "list-today",
        confidence: 0.93,
      });
      runtimeActions.managerAgentObserver?.onTextDelta("今日やるべきことです。");
      return buildManagerResult("今日やるべきことです。", "query");
    });

    const handlers = createAppRuntimeHandlers({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: { policy: { load: vi.fn() } } as never,
      linearEnv: {},
      slackTeamId: "T123",
      getManagerPolicy: () => ({ controlRoomChannelId: "CROOM" }) as never,
      setManagerPolicy: vi.fn(),
    });

    await handlers.handleSlackMessageEvent({
      channel: "C123",
      user: "U123",
      ts: "111.444",
      text: "今日やるべきことを教えて",
    }, "UBOT");
    await flushQueue();
    await vi.advanceTimersByTimeAsync(800);
    await flushQueue();
    await vi.runAllTimersAsync();
    await flushQueue();

    expect(webClient.chat.startStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.444",
      recipient_user_id: "U123",
      recipient_team_id: "T123",
      markdown_text: "今日やるべきことです。",
    });
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.444",
      text: "考え中...",
    });
    expect(webClient.chat.delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "placeholder.123",
    });
    expect(webClient.chat.stopStream).toHaveBeenCalledWith({
      channel: "C123",
      ts: "stream.123",
      markdown_text: undefined,
    });
    expect(webClient.chat.update).not.toHaveBeenCalled();
  });

  it("updates the streamed message with a provider-aware failure reply when a read-only turn fails", async () => {
    vi.useRealTimers();
    const { createAppRuntimeHandlers } = await import("../src/runtime/app-runtime.js");
    const webClient = createWebClient();
    const logger = createLogger();

    managerMocks.handleManagerMessage.mockImplementation(async (...callArgs: any[]) => {
      const runtimeActions = callArgs[5];
      runtimeActions.managerAgentObserver?.onIntentReport({
        intent: "conversation",
        conversationKind: "casual",
        confidence: 0.81,
      });
      runtimeActions.managerAgentObserver?.onTextDelta("途中の返信");
      throw new Error("429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit.\"},\"request_id\":\"req_streaming_failure\"}");
    });

    const handlers = createAppRuntimeHandlers({
      config: buildConfig(),
      logger: logger as never,
      webClient,
      systemPaths: {} as never,
      managerRepositories: { policy: { load: vi.fn() } } as never,
      linearEnv: {},
      slackTeamId: "T123",
      getManagerPolicy: () => ({ controlRoomChannelId: "CROOM" }) as never,
      setManagerPolicy: vi.fn(),
    });

    await handlers.handleSlackMessageEvent({
      channel: "C123",
      user: "U123",
      ts: "111.555",
      text: "教えて",
    }, "UBOT");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(webClient.chat.startStream).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C123",
      thread_ts: "111.555",
      recipient_user_id: "U123",
      recipient_team_id: "T123",
      markdown_text: "途中の返信",
    }));
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.555",
      text: "考え中...",
    });
    expect(webClient.chat.delete).toHaveBeenCalledWith({
      channel: "C123",
      ts: "placeholder.123",
    });
    expect(webClient.chat.update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "stream.123",
      text: expect.stringContaining("LLM 側のエラーです。Anthropic 429"),
      blocks: expect.any(Array),
    });
    expect(webClient.chat.stopStream).not.toHaveBeenCalled();
    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenCalledTimes(2);
    expect(threadWorkspaceMocks.appendThreadLog).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: "system",
        text: expect.stringContaining("LLM 側のエラーです。Anthropic 429"),
      }),
    );
  });
});
