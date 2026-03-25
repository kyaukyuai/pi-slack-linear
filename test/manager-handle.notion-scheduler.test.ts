import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleManagerMessage } from "../src/lib/manager.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { loadThreadNotionPageTarget } from "../src/lib/thread-notion-page-target.js";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";

const linearMocks = vi.hoisted(() => ({
  searchLinearIssues: vi.fn(),
  createManagedLinearIssue: vi.fn(),
  createManagedLinearIssueBatch: vi.fn(),
  updateManagedLinearIssue: vi.fn(),
  assignLinearIssue: vi.fn(),
  addLinearComment: vi.fn(),
  addLinearProgressComment: vi.fn(),
  addLinearRelation: vi.fn(),
  getLinearIssue: vi.fn(),
  markLinearIssueBlocked: vi.fn(),
  updateLinearIssueState: vi.fn(),
  updateLinearIssueStateWithComment: vi.fn(),
  listOpenLinearIssues: vi.fn(),
  listRiskyLinearIssues: vi.fn(),
}));

const slackContextMocks = vi.hoisted(() => ({
  getSlackThreadContext: vi.fn(),
  getRecentChannelContext: vi.fn(),
}));

const webResearchMocks = vi.hoisted(() => ({
  webSearchFetch: vi.fn(),
  webFetchUrl: vi.fn(),
}));

const notionMocks = vi.hoisted(() => ({
  archiveNotionPage: vi.fn(),
  createNotionAgendaPage: vi.fn(),
  updateNotionPage: vi.fn(),
}));

const piSessionMocks = vi.hoisted(() => ({
  runManagerAgentTurn: vi.fn(),
  runManagerSystemTurn: vi.fn(),
  runMessageRouterTurn: vi.fn(),
  runManagerReplyTurn: vi.fn(),
  runTaskPlanningTurn: vi.fn(),
  runResearchSynthesisTurn: vi.fn(),
  runFollowupResolutionTurn: vi.fn(),
}));

vi.mock("../src/lib/linear.js", () => ({
  searchLinearIssues: linearMocks.searchLinearIssues,
  createManagedLinearIssue: linearMocks.createManagedLinearIssue,
  createManagedLinearIssueBatch: linearMocks.createManagedLinearIssueBatch,
  updateManagedLinearIssue: linearMocks.updateManagedLinearIssue,
  assignLinearIssue: linearMocks.assignLinearIssue,
  addLinearComment: linearMocks.addLinearComment,
  addLinearProgressComment: linearMocks.addLinearProgressComment,
  addLinearRelation: linearMocks.addLinearRelation,
  getLinearIssue: linearMocks.getLinearIssue,
  markLinearIssueBlocked: linearMocks.markLinearIssueBlocked,
  updateLinearIssueState: linearMocks.updateLinearIssueState,
  updateLinearIssueStateWithComment: linearMocks.updateLinearIssueStateWithComment,
  listOpenLinearIssues: linearMocks.listOpenLinearIssues,
  listRiskyLinearIssues: linearMocks.listRiskyLinearIssues,
}));

vi.mock("../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
  getRecentChannelContext: slackContextMocks.getRecentChannelContext,
}));

vi.mock("../src/lib/web-research.js", () => ({
  webSearchFetch: webResearchMocks.webSearchFetch,
  webFetchUrl: webResearchMocks.webFetchUrl,
}));

vi.mock("../src/lib/notion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/notion.js")>("../src/lib/notion.js");
  return {
    ...actual,
    archiveNotionPage: notionMocks.archiveNotionPage,
    createNotionAgendaPage: notionMocks.createNotionAgendaPage,
    updateNotionPage: notionMocks.updateNotionPage,
  };
});

vi.mock("../src/lib/pi-session.js", () => ({
  runManagerAgentTurn: piSessionMocks.runManagerAgentTurn,
  runManagerSystemTurn: piSessionMocks.runManagerSystemTurn,
  runMessageRouterTurn: piSessionMocks.runMessageRouterTurn,
  runManagerReplyTurn: piSessionMocks.runManagerReplyTurn,
  runTaskPlanningTurn: piSessionMocks.runTaskPlanningTurn,
  runResearchSynthesisTurn: piSessionMocks.runResearchSynthesisTurn,
  runFollowupResolutionTurn: piSessionMocks.runFollowupResolutionTurn,
}));

describe("handleManagerMessage Notion and scheduler flows", () => {
  let workspaceDir: string;
  let systemPaths: ReturnType<typeof buildSystemPaths>;

  const config = {
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
    anthropicApiKey: undefined,
    linearApiKey: "lin_api_test",
    linearWorkspace: "kyaukyuai",
    linearTeamKey: "AIC",
    notionApiToken: "secret_test",
    notionAgendaParentPageId: "parent-page-1",
    botModel: "claude-sonnet-4-5",
    botThinkingLevel: "minimal" as const,
    botMaxOutputTokens: undefined,
    botRetryMaxRetries: 1,
    workspaceDir: "",
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

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-notion-scheduler-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset();
    linearMocks.assignLinearIssue.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearComment.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearProgressComment.mockReset().mockResolvedValue({ id: "comment-1", body: "ok" });
    linearMocks.addLinearRelation.mockReset().mockResolvedValue(undefined);
    linearMocks.getLinearIssue.mockReset();
    linearMocks.markLinearIssueBlocked.mockReset();
    linearMocks.updateLinearIssueState.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset();
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.listOpenLinearIssues.mockReset().mockResolvedValue([]);

    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-notion",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
    notionMocks.archiveNotionPage.mockReset().mockResolvedValue({
      id: "notion-page-1",
      object: "page",
      title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
      url: "https://www.notion.so/page-1",
      inTrash: true,
      raw: {},
    });
    notionMocks.createNotionAgendaPage.mockReset().mockResolvedValue({
      id: "notion-page-1",
      object: "page",
      title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
      url: "https://www.notion.so/page-1",
      createdTime: "2026-03-24T00:00:00.000Z",
    });
    notionMocks.updateNotionPage.mockReset().mockResolvedValue({
      id: "notion-page-1",
      object: "page",
      title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
      url: "https://www.notion.so/page-1",
      raw: {},
    });
    piSessionMocks.runManagerAgentTurn.mockReset();
    piSessionMocks.runManagerSystemTurn.mockReset().mockRejectedValue(new Error("manager system fallback"));
    piSessionMocks.runMessageRouterTurn.mockReset();
    piSessionMocks.runManagerReplyTurn.mockReset();
    piSessionMocks.runTaskPlanningTurn.mockReset();
    piSessionMocks.runResearchSynthesisTurn.mockReset();
    piSessionMocks.runFollowupResolutionTurn.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("keeps a quoted linked system log for Notion agenda creation when the agent reply has no link", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "「2026.03.26 | AIクローンプラットフォーム Vol.1」のアジェンダを Notion に作成します。目的・議題・確認事項・次のアクションの構成にしました。",
      toolCalls: [],
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
          summary: "進捗共有と進め方のすりあわせです。",
          reasonSummary: "Notion に会議用アジェンダを作る依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.95,
        summary: "Notion に会議用アジェンダを作る依頼です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-agenda",
        messageTs: "msg-notion-agenda-1",
        userId: "U1",
        text: "Notion にアジェンダを作って",
      },
      new Date("2026-03-24T00:22:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("アジェンダを Notion に作成します。");
    expect(result.reply).toContain("> system log: Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(notionMocks.createNotionAgendaPage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "2026.03.26 | AIクローンプラットフォーム Vol.1",
        parentPageId: "parent-page-1",
      }),
      expect.any(Object),
    );
  });

  it("keeps a quoted linked system log for Notion page updates when the agent reply has no link", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "その Notion ページに補足を追記しました。",
      toolCalls: [],
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-1",
          mode: "append",
          summary: "プロジェクトの進め方を追記しました。",
          reasonSummary: "直前の Notion ページを更新する依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.9,
        summary: "Notion ページ更新の依頼です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-update",
        messageTs: "msg-notion-update-1",
        userId: "U1",
        text: "そのページに追記して",
      },
      new Date("2026-03-24T00:24:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Notion ページに補足を追記しました。");
    expect(result.reply).toContain("> system log: Notion page updated: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-1",
        mode: "append",
        summary: "プロジェクトの進め方を追記しました。",
      }),
      expect.any(Object),
    );
  });

  it("keeps a quoted linked system log for Notion page archive when the agent reply has no link", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "その Notion ページをアーカイブしました。",
      toolCalls: [],
      proposals: [
        {
          commandType: "archive_notion_page",
          pageId: "notion-page-1",
          reasonSummary: "不要になった Notion ページを削除する依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.9,
        summary: "Notion ページ archive の依頼です。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-archive",
        messageTs: "msg-notion-archive-1",
        userId: "U1",
        text: "そのページを削除して",
      },
      new Date("2026-03-24T00:25:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Notion ページをアーカイブしました。");
    expect(result.reply).toContain("> system log: Notion page archived: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(notionMocks.archiveNotionPage).toHaveBeenCalledWith(
      "notion-page-1",
      expect.any(Object),
    );
  });

  it("keeps the latest active Notion page target for generic follow-ups in the same thread", async () => {
    notionMocks.createNotionAgendaPage
      .mockReset()
      .mockResolvedValueOnce({
        id: "notion-page-old",
        object: "page",
        title: "2026.03.25 | AIクローンプラットフォーム Vol.1",
        url: "https://www.notion.so/page-old",
        createdTime: "2026-03-25T02:55:00.000Z",
      })
      .mockResolvedValueOnce({
        id: "notion-page-new",
        object: "page",
        title: "2026.03.25 | AIクローンプラットフォーム Vol.2",
        url: "https://www.notion.so/page-new",
        createdTime: "2026-03-25T03:00:00.000Z",
      });
    notionMocks.archiveNotionPage.mockReset().mockResolvedValueOnce({
      id: "notion-page-old",
      object: "page",
      title: "2026.03.25 | AIクローンプラットフォーム Vol.1",
      url: "https://www.notion.so/page-old",
      inTrash: true,
      raw: {},
    });
    notionMocks.updateNotionPage.mockReset().mockResolvedValueOnce({
      id: "notion-page-new",
      object: "page",
      title: "2026.03.25 | AIクローンプラットフォーム Vol.2",
      url: "https://www.notion.so/page-new",
      raw: {},
    });

    piSessionMocks.runManagerAgentTurn
      .mockResolvedValueOnce({
        reply: "最初の Notion アジェンダを作成します。",
        toolCalls: [],
        proposals: [
          {
            commandType: "create_notion_agenda",
            title: "2026.03.25 | AIクローンプラットフォーム Vol.1",
            reasonSummary: "最初のアジェンダを作成します。",
          },
        ],
        invalidProposalCount: 0,
        intentReport: {
          intent: "create_work",
          confidence: 0.9,
          summary: "最初のアジェンダ作成です。",
        },
      })
      .mockResolvedValueOnce({
        reply: "古い Notion ページをアーカイブします。",
        toolCalls: [],
        proposals: [
          {
            commandType: "archive_notion_page",
            pageId: "notion-page-old",
            reasonSummary: "古い Notion ページを整理します。",
          },
        ],
        invalidProposalCount: 0,
        intentReport: {
          intent: "create_work",
          confidence: 0.9,
          summary: "古いページのアーカイブです。",
        },
      })
      .mockResolvedValueOnce({
        reply: "新しい Notion アジェンダを作成します。",
        toolCalls: [],
        proposals: [
          {
            commandType: "create_notion_agenda",
            title: "2026.03.25 | AIクローンプラットフォーム Vol.2",
            reasonSummary: "新しいアジェンダを作成します。",
          },
        ],
        invalidProposalCount: 0,
        intentReport: {
          intent: "create_work",
          confidence: 0.9,
          summary: "新しいアジェンダ作成です。",
        },
      })
      .mockResolvedValueOnce({
        reply: "決定事項を追記します。",
        toolCalls: [],
        proposals: [
          {
            commandType: "update_notion_page",
            pageId: "notion-page-old",
            mode: "append",
            summary: "決定事項を追記しました。",
            reasonSummary: "同じ thread の Notion ページに決定事項を追記します。",
          },
        ],
        invalidProposalCount: 0,
        intentReport: {
          intent: "create_work",
          confidence: 0.9,
          summary: "Notion ページ更新の依頼です。",
        },
      });

    const thread = {
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-notion-active-target",
      userId: "U1",
    };

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        ...thread,
        messageTs: "msg-notion-target-1",
        text: "Notion にアジェンダを作って",
      },
      new Date("2026-03-25T02:55:00.000Z"),
    );
    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        ...thread,
        messageTs: "msg-notion-target-2",
        text: "そのページを削除して",
      },
      new Date("2026-03-25T02:58:00.000Z"),
    );
    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        ...thread,
        messageTs: "msg-notion-target-3",
        text: "既存ページをアーカイブして新規作成して",
      },
      new Date("2026-03-25T03:00:00.000Z"),
    );

    const currentTarget = await loadThreadNotionPageTarget(
      buildThreadPaths(workspaceDir, thread.channelId, thread.rootThreadTs),
    );
    expect(currentTarget).toMatchObject({
      pageId: "notion-page-new",
      title: "2026.03.25 | AIクローンプラットフォーム Vol.2",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        ...thread,
        messageTs: "msg-notion-target-4",
        text: "Notion に決定事項を追記しておいて",
      },
      new Date("2026-03-25T03:01:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-new",
        mode: "append",
        summary: "決定事項を追記しました。",
      }),
      expect.any(Object),
    );
    expect(result.reply).toContain("> system log: Notion page updated: <https://www.notion.so/page-new|2026.03.25 | AIクローンプラットフォーム Vol.2>");
  });

  it("keeps a quoted system log with a link when a custom scheduler job is run immediately", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "weekly-notion-agenda-ai-clone を今すぐ実行しました。結果を確認してください。",
      toolCalls: [],
      proposals: [
        {
          commandType: "run_scheduler_job_now",
          jobId: "weekly-notion-agenda-ai-clone",
          reasonSummary: "動作確認のため 1 回だけ実行します。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "run_schedule",
        confidence: 0.96,
        summary: "custom scheduler job の即時実行です。",
      },
    });

    await writeFile(systemPaths.jobsFile, `${JSON.stringify([
      {
        id: "weekly-notion-agenda-ai-clone",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "Notion に AIクローンプラットフォームのアジェンダを作成する",
        kind: "weekly",
        weekday: "thu",
        time: "09:00",
        nextRunAt: "2026-03-26T00:00:00.000Z",
      },
    ], null, 2)}\n`, "utf8");

    const runSchedulerJobNow = vi.fn().mockResolvedValue({
      status: "ok",
      persistedSummary: "Notion にアジェンダを作成しました。",
      commitSummary: "Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>",
      executedAt: "2026-03-24T01:05:00.000Z",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-run-now",
        messageTs: "msg-scheduler-run-now-1",
        userId: "U1",
        text: "weekly-notion-agenda-ai-clone を今すぐ実行して",
      },
      new Date("2026-03-24T01:05:00.000Z"),
      undefined,
      { runSchedulerJobNow },
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("weekly-notion-agenda-ai-clone を今すぐ実行しました。");
    expect(result.reply).toContain("> system log: Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
    expect(runSchedulerJobNow).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "weekly-notion-agenda-ai-clone",
      }),
    );
  });
});
