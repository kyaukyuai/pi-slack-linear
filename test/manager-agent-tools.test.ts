import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/lib/config.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { createManagerAgentTools } from "../src/lib/manager-agent-tools.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";

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
  notionAgendaParentPageId: "parent-page-1",
  botModel: "claude-sonnet-4-6",
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
  logLevel: "info",
};

describe("manager agent tools", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns dueRelativeLabel and daysUntilDue in review facts", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-24T08:00:00Z"));
      linearMocks.listOpenLinearIssues.mockResolvedValue([
        {
          id: "issue-parent",
          identifier: "AIC-39",
          title: "AIマネージャーを実用レベルへ引き上げる",
          url: "https://linear.app/kyaukyuai/issue/AIC-39",
          dueDate: "2026-03-26",
          state: { id: "state-review", name: "In Review", type: "started" },
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
          children: [],
        },
      ]);

      const tools = createManagerAgentTools(config, {
        policy: { load: vi.fn() },
        workgraph: {} as never,
      });
      const tool = tools.find((entry) => entry.name === "linear_list_review_facts");

      expect(tool).toBeDefined();
      const result = await tool!.execute("tool-call-relative-due", { limit: 10 });
      const details = result.details as Array<Record<string, unknown>>;

      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({
        identifier: "AIC-39",
        dueDate: "2026-03-26",
        daysUntilDue: 2,
        dueRelativeLabel: "2日後",
      });
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("lists unified custom and built-in schedules", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "manager-agent-tools-scheduler-"));
    tempDirs.push(workspaceDir);
    const systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);
    await writeFile(systemPaths.jobsFile, `${JSON.stringify([
      {
        id: "custom-daily-check",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "custom prompt",
        kind: "daily",
        time: "11:00",
      },
      {
        id: "manager-review-evening",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "manager review: evening",
        kind: "daily",
        time: "17:00",
        action: "evening-review",
      },
    ], null, 2)}\n`, "utf8");

    const tools = createManagerAgentTools(
      { ...config, workspaceDir },
      {
        policy: { load: vi.fn() },
        workgraph: {} as never,
      },
    );
    const tool = tools.find((entry) => entry.name === "scheduler_list_schedules");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-schedules", {});
    const details = result.details as Array<Record<string, unknown>>;

    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "manager-review-evening",
          kind: "evening-review",
          source: "policy",
          scheduleType: "daily",
        }),
        expect.objectContaining({
          id: "custom-daily-check",
          kind: "custom-job",
          source: "jobs",
          scheduleType: "daily",
          time: "11:00",
        }),
        expect.objectContaining({
          id: "heartbeat",
          kind: "heartbeat",
          source: "policy",
        }),
      ]),
    );
  });
});
