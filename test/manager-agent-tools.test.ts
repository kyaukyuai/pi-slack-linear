import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/lib/config.js";
import { createManagerAgentTools } from "../src/lib/manager-agent-tools.js";

const linearMocks = vi.hoisted(() => ({
  getLinearIssue: vi.fn(),
  listOpenLinearIssues: vi.fn(),
}));

vi.mock("../src/lib/linear.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/linear.js")>("../src/lib/linear.js");
  return {
    ...actual,
    getLinearIssue: linearMocks.getLinearIssue,
    listOpenLinearIssues: linearMocks.listOpenLinearIssues,
  };
});

const config: AppConfig = {
  slackAppToken: "xapp-test",
  slackBotToken: "xoxb-test",
  slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
  anthropicApiKey: "anthropic-test",
  linearApiKey: "lin_api_test",
  linearWorkspace: "kyaukyuai",
  linearTeamKey: "AIC",
  notionApiToken: "secret_test",
  botModel: "claude-sonnet-4-6",
  workspaceDir: "/tmp/pi-slack-linear",
  heartbeatIntervalMin: 30,
  heartbeatActiveLookbackHours: 24,
  schedulerPollSec: 30,
  workgraphMaintenanceIntervalMin: 15,
  workgraphHealthWarnActiveEvents: 200,
  workgraphAutoCompactMaxActiveEvents: 500,
  logLevel: "info",
};

describe("manager agent tools", () => {
  it("returns review facts with explicit open and closed child issue state", async () => {
    linearMocks.listOpenLinearIssues.mockResolvedValue([
      {
        id: "issue-parent",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
        url: "https://linear.app/kyaukyuai/issue/AIC-39",
        state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        assignee: { id: "user-1", displayName: "y.kakui" },
        children: [
          {
            id: "issue-child",
            identifier: "AIC-41",
            title: "Notion連携の実装",
            url: "https://linear.app/kyaukyuai/issue/AIC-41",
          },
        ],
        relations: [],
        inverseRelations: [],
      },
    ]);
    linearMocks.getLinearIssue.mockResolvedValue({
      id: "issue-child",
      identifier: "AIC-41",
      title: "Notion連携の実装",
      url: "https://linear.app/kyaukyuai/issue/AIC-41",
      state: { id: "state-done", name: "Done", type: "done" },
      completedAt: "2026-03-23T08:56:11.797Z",
      relations: [],
      inverseRelations: [],
    });

    const tools = createManagerAgentTools(config, {
      policy: { load: vi.fn() },
      workgraph: {} as never,
    });
    const tool = tools.find((entry) => entry.name === "linear_list_review_facts");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-1", { limit: 10 });
    const details = result.details as Array<Record<string, unknown>>;

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      identifier: "AIC-39",
      stateName: "Backlog",
      stateType: "unstarted",
      isOpen: true,
      openChildren: [],
      closedChildren: [
        expect.objectContaining({
          identifier: "AIC-41",
          stateName: "Done",
          stateType: "done",
          isOpen: false,
          completedAt: "2026-03-23T08:56:11.797Z",
        }),
      ],
    });
  });
});
