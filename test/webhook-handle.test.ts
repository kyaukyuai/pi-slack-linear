import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleIssueCreatedWebhook } from "../src/orchestrators/webhooks/handle-issue-created.js";
import { LlmProviderFailureError } from "../src/lib/llm-failure.js";
import {
  WEBHOOK_INITIAL_PROPOSAL_DEDUPE_KEY_PREFIX,
  WEBHOOK_INITIAL_PROPOSAL_HEADING,
  WEBHOOK_INITIAL_PROPOSAL_MARKER,
} from "../src/orchestrators/webhooks/initial-proposal-comment.js";

const mocks = vi.hoisted(() => ({
  runManagerSystemTurn: vi.fn(),
  commitManagerCommandProposals: vi.fn(),
  getLinearIssue: vi.fn(),
}));

vi.mock("../src/lib/pi-session.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/pi-session.js")>("../src/lib/pi-session.js");
  return {
    ...actual,
    runManagerSystemTurn: mocks.runManagerSystemTurn,
  };
});

vi.mock("../src/lib/manager-command-commit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/manager-command-commit.js")>("../src/lib/manager-command-commit.js");
  return {
    ...actual,
    commitManagerCommandProposals: mocks.commitManagerCommandProposals,
  };
});

vi.mock("../src/lib/linear.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/linear.js")>("../src/lib/linear.js");
  return {
    ...actual,
    getLinearIssue: mocks.getLinearIssue,
  };
});

describe("handleIssueCreatedWebhook", () => {
  beforeEach(() => {
    mocks.runManagerSystemTurn.mockReset();
    mocks.commitManagerCommandProposals.mockReset();
    mocks.getLinearIssue.mockReset();
    mocks.getLinearIssue.mockResolvedValue({
      id: "issue-uuid-1",
      identifier: "AIC-123",
      title: "Webhook generated issue",
      description: "Check whether the AI should take action.",
      url: "https://linear.app/kyaukyuai/issue/AIC-123",
      relations: [],
      inverseRelations: [],
      comments: [],
    });
  });

  const args = {
    config: {
      slackAppToken: "xapp-test",
      slackBotToken: "xoxb-test",
      slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
      anthropicApiKey: undefined,
      linearApiKey: "lin_api_test",
      linearWorkspace: "kyaukyuai",
      linearTeamKey: "AIC",
      notionApiToken: undefined,
      notionAgendaParentPageId: undefined,
      botModel: "claude-sonnet-4-5",
      botThinkingLevel: "minimal",
      botMaxOutputTokens: undefined,
      botRetryMaxRetries: 1,
      workspaceDir: "/tmp/cogito-work-manager",
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
    },
    paths: {
      rootDir: "/tmp/cogito-work-manager/system/sessions/webhook/AIC-123",
      sessionFile: "/tmp/cogito-work-manager/system/sessions/webhook/AIC-123/session.jsonl",
      logFile: "/tmp/cogito-work-manager/system/sessions/webhook/AIC-123/log.jsonl",
      attachmentsDir: "/tmp/cogito-work-manager/system/sessions/webhook/AIC-123/attachments",
      scratchDir: "/tmp/cogito-work-manager/system/sessions/webhook/AIC-123/scratch",
    },
    repositories: {
      ownerMap: {} as never,
      planning: {} as never,
      followups: {} as never,
      workgraph: {} as never,
      personalization: {} as never,
      notionPages: {} as never,
    },
    policy: {
      controlRoomChannelId: "C0ALAMDRB9V",
    },
    issue: {
      id: "issue-uuid-1",
      identifier: "AIC-123",
      title: "Webhook generated issue",
      description: "Check whether the AI should take action.",
      url: "https://linear.app/kyaukyuai/issue/AIC-123",
      relations: [],
      inverseRelations: [],
    },
    deliveryId: "delivery-1",
    webhookId: "webhook-1",
    now: new Date("2026-03-24T03:00:00.000Z"),
    env: {
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_WORKSPACE: "kyaukyuai",
      LINEAR_TEAM_KEY: "AIC",
    },
    currentDate: "2026-03-24",
    runAtJst: "2026-03-24 12:00 JST",
  } as const;

  it("returns noop when the agent commits nothing", async () => {
    mocks.runManagerSystemTurn.mockResolvedValue({
      reply: "No immediate action.",
      toolCalls: [],
      proposals: [],
      invalidProposalCount: 0,
      intentReport: { intent: "scheduler" },
      taskExecutionDecision: {
        decision: "noop",
        targetIssueId: "issue-uuid-1",
        targetIssueIdentifier: "AIC-123",
        summary: "human implementation task",
      },
    });
    mocks.commitManagerCommandProposals.mockResolvedValue({
      committed: [],
      rejected: [],
      replySummaries: [],
    });

    await expect(handleIssueCreatedWebhook(args)).resolves.toMatchObject({
      status: "noop",
      reason: "human implementation task",
      createdIssueIds: [],
    });
  });

  it("commits an initial proposal comment for a detailed issue", async () => {
    mocks.runManagerSystemTurn.mockResolvedValue({
      reply: "AIC-123 に初回提案コメントを追加します。",
      toolCalls: [],
      proposals: [{
        commandType: "add_comment",
        issueId: "AIC-123",
        body: "提案内容です。",
        reasonSummary: "初回提案を残すため",
      }],
      invalidProposalCount: 0,
      intentReport: { intent: "run_task" },
    });
    mocks.commitManagerCommandProposals.mockResolvedValue({
      committed: [
        {
          commandType: "add_comment",
          issueIds: ["AIC-123"],
          summary: "AIC-123 にコメントを追加しました。",
        },
      ],
      rejected: [],
      replySummaries: ["AIC-123 にコメントを追加しました。"],
    });

    const result = await handleIssueCreatedWebhook(args);

    expect(result).toMatchObject({
      status: "committed",
      createdIssueIds: [],
    });
    expect(mocks.commitManagerCommandProposals).toHaveBeenCalledWith(expect.objectContaining({
      proposals: [expect.objectContaining({
        commandType: "add_comment",
        issueId: "AIC-123",
        body: `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n${WEBHOOK_INITIAL_PROPOSAL_HEADING}\n\n提案内容です。`,
        dedupeKeyCandidate: `${WEBHOOK_INITIAL_PROPOSAL_DEDUPE_KEY_PREFIX}:AIC-123`,
      })],
    }));
  });

  it("adds a best-effort initial proposal comment even for a thin issue", async () => {
    mocks.getLinearIssue.mockResolvedValue({
      id: "issue-uuid-1",
      identifier: "AIC-123",
      title: "Webhook generated issue",
      description: "",
      url: "https://linear.app/kyaukyuai/issue/AIC-123",
      relations: [],
      inverseRelations: [],
      comments: [],
    });
    mocks.runManagerSystemTurn.mockResolvedValue({
      reply: "AIC-123 に仮説ベースの提案コメントを追加します。",
      toolCalls: [],
      proposals: [{
        commandType: "add_comment",
        issueId: "AIC-123",
        body: "最初に確認する論点と暫定方針を残します。",
        reasonSummary: "薄い issue にも best-effort で初回提案を残すため",
      }],
      invalidProposalCount: 0,
      intentReport: { intent: "run_task" },
    });
    mocks.commitManagerCommandProposals.mockResolvedValue({
      committed: [
        {
          commandType: "add_comment",
          issueIds: ["AIC-123"],
          summary: "AIC-123 にコメントを追加しました。",
        },
      ],
      rejected: [],
      replySummaries: ["AIC-123 にコメントを追加しました。"],
    });

    await expect(handleIssueCreatedWebhook(args)).resolves.toMatchObject({
      status: "committed",
      createdIssueIds: [],
    });
  });

  it("returns noop when an initial proposal comment already exists", async () => {
    mocks.getLinearIssue.mockResolvedValue({
      id: "issue-uuid-1",
      identifier: "AIC-123",
      title: "Webhook generated issue",
      description: "Check whether the AI should take action.",
      url: "https://linear.app/kyaukyuai/issue/AIC-123",
      relations: [],
      inverseRelations: [],
      comments: [
        {
          id: "comment-1",
          body: `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n${WEBHOOK_INITIAL_PROPOSAL_HEADING}\n\n既存コメント`,
          createdAt: "2026-03-24T03:00:00.000Z",
          user: { name: "cogito" },
        },
      ],
    });

    await expect(handleIssueCreatedWebhook(args)).resolves.toMatchObject({
      status: "noop",
      createdIssueIds: [],
      reason: "initial proposal comment already exists",
    });
    expect(mocks.runManagerSystemTurn).not.toHaveBeenCalled();
    expect(mocks.commitManagerCommandProposals).not.toHaveBeenCalled();
  });

  it("returns provider-aware Slack reply while keeping the raw reason for LLM failures", async () => {
    mocks.runManagerSystemTurn.mockRejectedValueOnce(new LlmProviderFailureError({
      kind: "provider",
      provider: "anthropic",
      statusCode: 429,
      providerErrorType: "rate_limit_error",
      publicSummary: "Anthropic 429 rate_limit_error",
      technicalMessage: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_test_123\"}",
      requestId: "req_test_123",
    }));

    await expect(handleIssueCreatedWebhook(args)).resolves.toMatchObject({
      status: "failed",
      reason: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_test_123\"}",
      reply: "LLM 側のエラーです。Anthropic 429 rate_limit_error が発生しました。",
    });
  });
});
