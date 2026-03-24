import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleIssueCreatedWebhook } from "../src/orchestrators/webhooks/handle-issue-created.js";

const mocks = vi.hoisted(() => ({
  runManagerSystemTurn: vi.fn(),
  commitManagerCommandProposals: vi.fn(),
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

describe("handleIssueCreatedWebhook", () => {
  beforeEach(() => {
    mocks.runManagerSystemTurn.mockReset();
    mocks.commitManagerCommandProposals.mockReset();
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
    });
    mocks.commitManagerCommandProposals.mockResolvedValue({
      committed: [],
      rejected: [],
      replySummaries: [],
    });

    await expect(handleIssueCreatedWebhook(args)).resolves.toMatchObject({
      status: "noop",
      createdIssueIds: [],
    });
  });

  it("returns committed with created issue ids from create proposals", async () => {
    mocks.runManagerSystemTurn.mockResolvedValue({
      reply: "AIC-123 に対して親子 task を作ります。",
      toolCalls: [],
      proposals: [{ commandType: "create_issue_batch" }],
      invalidProposalCount: 0,
      intentReport: { intent: "create_work" },
    });
    mocks.commitManagerCommandProposals.mockResolvedValue({
      committed: [
        {
          commandType: "create_issue_batch",
          issueIds: ["AIC-200", "AIC-201"],
          summary: "AIC-200 と AIC-201 を作成しました。",
        },
      ],
      rejected: [],
      replySummaries: ["AIC-200 と AIC-201 を作成しました。"],
    });

    await expect(handleIssueCreatedWebhook(args)).resolves.toMatchObject({
      status: "committed",
      createdIssueIds: ["AIC-200", "AIC-201"],
    });
  });

  it("returns failed when proposals are rejected", async () => {
    mocks.runManagerSystemTurn.mockResolvedValue({
      reply: "確認したいです。",
      toolCalls: [],
      proposals: [{ commandType: "create_issue" }],
      invalidProposalCount: 0,
      intentReport: { intent: "create_work" },
    });
    mocks.commitManagerCommandProposals.mockResolvedValue({
      committed: [],
      rejected: [
        {
          proposal: { commandType: "create_issue" },
          reason: "validation failed",
        },
      ],
      replySummaries: [],
    });

    await expect(handleIssueCreatedWebhook(args)).resolves.toMatchObject({
      status: "failed",
      reason: "validation failed",
    });
  });
});
