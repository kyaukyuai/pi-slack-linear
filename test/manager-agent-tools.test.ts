import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/lib/config.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { createManagerAgentTools } from "../src/lib/manager-agent-tools.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { WEBHOOK_INITIAL_PROPOSAL_MARKER } from "../src/orchestrators/webhooks/initial-proposal-comment.js";

const linearMocks = vi.hoisted(() => ({
  getLinearIssue: vi.fn(),
  listOpenLinearIssues: vi.fn(),
  searchLinearIssues: vi.fn(),
}));

const notionMocks = vi.hoisted(() => ({
  getNotionPageContent: vi.fn(),
}));

vi.mock("../src/lib/linear.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/linear.js")>("../src/lib/linear.js");
  return {
    ...actual,
    getLinearIssue: linearMocks.getLinearIssue,
    listOpenLinearIssues: linearMocks.listOpenLinearIssues,
    searchLinearIssues: linearMocks.searchLinearIssues,
  };
});

vi.mock("../src/lib/notion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/notion.js")>("../src/lib/notion.js");
  return {
    ...actual,
    getNotionPageContent: notionMocks.getNotionPageContent,
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
  logLevel: "info",
};

function buildRepositoriesForTools() {
  return {
    policy: { load: vi.fn() },
    ownerMap: {
      load: vi.fn().mockResolvedValue({
        defaultOwner: "kyaukyuai",
        entries: [
          {
            id: "kyaukyuai",
            domains: ["default"],
            keywords: ["manager"],
            linearAssignee: "y.kakui",
            slackUserId: "U01L86BCA9X",
            primary: true,
          },
        ],
      }),
      save: vi.fn(),
    },
    workgraph: {} as never,
  };
}

describe("manager agent tools", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    notionMocks.getNotionPageContent.mockReset();
    linearMocks.getLinearIssue.mockReset();
    linearMocks.listOpenLinearIssues.mockReset();
    linearMocks.searchLinearIssues.mockReset();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("validates conversationKind in report_manager_intent", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "report_manager_intent");

    expect(tool).toBeDefined();

    const ok = await tool!.execute("tool-call-intent-ok", {
      intent: "conversation",
      conversationKind: "greeting",
      confidence: 0.9,
      summary: "挨拶です。",
    });
    expect(ok.details).toMatchObject({
      intentReport: {
        intent: "conversation",
        conversationKind: "greeting",
      },
    });

    await expect(tool!.execute("tool-call-intent-invalid", {
      intent: "conversation",
      confidence: 0.9,
      summary: "挨拶です。",
    })).rejects.toThrow(/conversationKind/i);
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

      const tools = createManagerAgentTools(config, buildRepositoriesForTools());
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

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
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

  it("includes comment facts in linear_get_issue_facts", async () => {
    linearMocks.getLinearIssue.mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-85",
      title: "Slackから自動収集してAIクローンに反映する仕組みの検討",
      url: "https://linear.app/kyaukyuai/issue/AIC-85",
      description: "どのような仕組みにすべきか検討したい。",
      state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
      relations: [],
      inverseRelations: [],
      comments: [
        {
          id: "comment-1",
          body: `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n\n既存の初回提案コメント`,
          createdAt: "2026-03-27T02:25:00.000Z",
          user: { name: "cogito" },
        },
      ],
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_get_issue_facts");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-issue-facts", { issueId: "AIC-85" });

    expect(result.details).toMatchObject({
      identifier: "AIC-85",
      commentCount: 1,
      comments: [
        expect.objectContaining({
          body: `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n\n既存の初回提案コメント`,
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
      buildRepositoriesForTools(),
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

  it("shows full Notion page lines in the default content window when they fit", async () => {
    notionMocks.getNotionPageContent.mockResolvedValueOnce({
      id: "notion-page-1",
      title: "AIクローンプラットフォーム 初回会議共有資料",
      url: "https://www.notion.so/notion-page-1",
      excerpt: "初回会議の概要",
      lines: [
        { text: "1. 本日の確認事項" },
        { text: "2. 3ヶ月後の金澤クローンのゴール" },
        { text: "3. その先に目指すビジョン" },
        { text: "4. NotebookLM との違い" },
        { text: "5. 今回の実施スコープ" },
        { text: "6. 3ヶ月の進め方" },
        { text: "7. 本日合意したいこと" },
      ],
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "notion_get_page_content");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-notion-content", { pageId: "notion-page-1" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Extracted page lines: 7 total.");
    expect(text).toContain("Page lines (1-7 of 7):");
    expect(text).toContain("6. 3ヶ月の進め方");
    expect(text).toContain("7. 本日合意したいこと");
  });

  it("supports continuing through a longer Notion page with startLine", async () => {
    notionMocks.getNotionPageContent.mockResolvedValueOnce({
      id: "notion-page-1",
      title: "AIクローンプラットフォーム 初回会議共有資料",
      url: "https://www.notion.so/notion-page-1",
      excerpt: "初回会議の概要",
      lines: Array.from({ length: 61 }, (_, index) => ({ text: `Line ${index + 1}` })),
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "notion_get_page_content");

    expect(tool).toBeDefined();
    const result = await tool!.execute("tool-call-notion-content", { pageId: "notion-page-1", startLine: 21, maxLines: 20 });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Extracted page lines: 61 total.");
    expect(text).toContain("Page lines (21-40 of 61):");
    expect(text).toContain("Line 21");
    expect(text).toContain("Line 40");
    expect(text).toContain("Call notion_get_page_content again with startLine=41");
  });

  it("includes a dedicated workspace memory proposal tool", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());

    expect(tools.some((entry) => entry.name === "propose_update_workspace_memory")).toBe(true);
  });

  it("includes dedicated workspace config read and proposal tools", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());

    expect(tools.some((entry) => entry.name === "workspace_get_agenda_template")).toBe(true);
    expect(tools.some((entry) => entry.name === "workspace_get_heartbeat_prompt")).toBe(true);
    expect(tools.some((entry) => entry.name === "workspace_get_owner_map")).toBe(true);
    expect(tools.some((entry) => entry.name === "propose_replace_workspace_text_file")).toBe(true);
    expect(tools.some((entry) => entry.name === "propose_update_owner_map")).toBe(true);
    expect(tools.some((entry) => entry.name === "propose_post_slack_message")).toBe(true);
  });

  it("includes a structured existing-issue reuse proposal tool", async () => {
    const tools = createManagerAgentTools(config, buildRepositoriesForTools());

    expect(tools.some((entry) => entry.name === "propose_link_existing_issue")).toBe(true);
  });

  it("includes duplicate candidate search with deterministic multi-query recall", async () => {
    linearMocks.searchLinearIssues.mockImplementation(async ({ query }: { query: string }) => {
      if (/chatgpt/.test(query) || /プロジェクト 招待/.test(query)) {
        return [{
          id: "issue-61",
          identifier: "AIC-61",
          title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
          url: "https://linear.app/kyaukyuai/issue/AIC-61",
          state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
          updatedAt: "2026-03-27T06:00:00.000Z",
          relations: [],
          inverseRelations: [],
        }];
      }
      return [];
    });

    const tools = createManagerAgentTools(config, buildRepositoriesForTools());
    const tool = tools.find((entry) => entry.name === "linear_find_duplicate_candidates");

    expect(tool).toBeDefined();

    const result = await tool!.execute("tool-call-duplicate-candidates", {
      text: "金澤さんのChatGPTのプロジェクト招待",
    });

    expect(linearMocks.searchLinearIssues).toHaveBeenCalledTimes(5);
    expect(result.details).toMatchObject([
      {
        identifier: "AIC-61",
        matchedQueries: expect.arrayContaining(["金澤 chatgpt プロジェクト 招待", "プロジェクト 招待"]),
        matchedTokenCount: 4,
      },
    ]);
  });
});
