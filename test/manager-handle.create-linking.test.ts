import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleManagerMessage } from "../src/lib/manager.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { loadPendingManagerClarification } from "../src/lib/pending-manager-clarification.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
import { recordPlanningOutcome } from "../src/state/workgraph/recorder.js";
import { createDefaultTestManagerAgentTurn } from "./helpers/default-manager-agent-mock.js";

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

function defaultMessageRouter() {
  return {
    action: "create_work" as const,
    confidence: 0.9,
    reasoningSummary: "新規依頼です。",
  };
}

function defaultManagerReply() {
  return { reply: "対応しました。" };
}

describe("handleManagerMessage create and linking flow", () => {
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

  async function loadThreadProjection(threadKey: string) {
    return createFileBackedManagerRepositories(systemPaths).workgraph.project().then((projection) => projection.threads[threadKey]);
  }

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-create-linking-"));
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
    linearMocks.getLinearIssue.mockReset().mockImplementation(async (issueId: string) => ({
      id: `issue-${issueId}`,
      identifier: issueId,
      title: issueId,
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.markLinearIssueBlocked.mockReset();
    linearMocks.updateLinearIssueState.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset();
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.listOpenLinearIssues.mockReset().mockResolvedValue([]);

    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-create-linking",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
    notionMocks.archiveNotionPage.mockReset();
    notionMocks.createNotionAgendaPage.mockReset();
    notionMocks.updateNotionPage.mockReset();

    piSessionMocks.runManagerAgentTurn.mockReset().mockImplementation(createDefaultTestManagerAgentTurn({
      config: { ...config, workspaceDir },
      systemPaths,
      linearMocks: {
        listOpenLinearIssues: linearMocks.listOpenLinearIssues,
        searchLinearIssues: linearMocks.searchLinearIssues,
        getLinearIssue: linearMocks.getLinearIssue,
      },
      slackContextMocks: {
        getSlackThreadContext: slackContextMocks.getSlackThreadContext,
      },
      route: defaultMessageRouter,
      buildReply: defaultManagerReply,
    }));
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

  it("commits agent issue creation proposals exactly once", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "この依頼は登録しておきます。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.93,
              summary: "新規 task の依頼です。",
            },
          },
        },
        {
          toolName: "propose_create_issue",
          details: {
            proposal: {
              commandType: "create_issue",
              planningReason: "single-issue",
              threadParentHandling: "ignore",
              duplicateHandling: "create-new",
              issue: {
                title: "OPT社の社内チャネルへの招待依頼",
                description: "## Slack source\n招待してもらう task を追加する",
                assigneeMode: "assign",
                assignee: "y.kakui",
              },
              reasonSummary: "単発 task と判断しました。",
              dedupeKeyCandidate: "thread-create-1",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "create-new",
          issue: {
            title: "OPT社の社内チャネルへの招待依頼",
            description: "## Slack source\n招待してもらう task を追加する",
            assigneeMode: "assign",
            assignee: "y.kakui",
          },
          reasonSummary: "単発 task と判断しました。",
          dedupeKeyCandidate: "thread-create-1",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.93,
        summary: "新規 task の依頼です。",
      },
    });

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-900",
      identifier: "AIC-900",
      title: "OPT社の社内チャネルへの招待依頼",
      url: "https://linear.app/issue/AIC-900",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Backlog", type: "unstarted" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agent-create",
        messageTs: "msg-agent-2",
        userId: "U1",
        text: "OPT社の社内チャネルに招待してもらうタスクを追加して",
      },
      new Date("2026-03-19T06:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(1);
    expect(result.reply).toContain("AIC-900");
    expect(result.diagnostics?.agent).toMatchObject({
      source: "agent",
      intent: "create_work",
      proposalCount: 1,
      committedCommands: ["create_issue"],
    });
  });

  it("attaches single issue create proposals to the existing thread parent", async () => {
    await recordPlanningOutcome(createFileBackedManagerRepositories(systemPaths).workgraph, {
      occurredAt: "2026-03-23T00:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agent-child-create",
        messageTs: "seed-parent-msg",
      },
      messageFingerprint: "seed parent thread",
      parentIssue: {
        issueId: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      parentIssueId: "AIC-39",
      childIssues: [],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-39",
      originalText: "親 issue の作成",
    });

    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "issue 化しておきます。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.95,
              summary: "既存親の子 issue 追加です。",
            },
          },
        },
        {
          toolName: "propose_create_issue",
          details: {
            proposal: {
              commandType: "create_issue",
              planningReason: "single-issue",
              threadParentHandling: "attach",
              duplicateHandling: "create-new",
              issue: {
                title: "コギトをシステム設定・プロンプトに命名として反映する",
                description: "## Slack source\nissue 化してください",
                assigneeMode: "leave-unassigned",
              },
              reasonSummary: "既存親の子 issue にする提案です。",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "attach",
          duplicateHandling: "create-new",
          issue: {
            title: "コギトをシステム設定・プロンプトに命名として反映する",
            description: "## Slack source\nissue 化してください",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "既存親の子 issue にする提案です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.95,
        summary: "既存親の子 issue 追加です。",
      },
    });

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-40",
      identifier: "AIC-40",
      title: "コギトをシステム設定・プロンプトに命名として反映する",
      url: "https://linear.app/kyaukyuai/issue/AIC-40",
      parent: {
        id: "parent-39",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-agent-child-create",
        messageTs: "msg-agent-child-1",
        userId: "U1",
        text: "issue 化してください",
      },
      new Date("2026-03-23T00:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: "AIC-39",
        title: "コギトをシステム設定・プロンプトに命名として反映する",
      }),
      expect.any(Object),
    );
    expect(result.reply).toContain("親は AIC-39 AIマネージャーを実用レベルへ引き上げる");
    expect(result.reply).toContain("子 task として <https://linear.app/kyaukyuai/issue/AIC-40|AIC-40 コギトをシステム設定・プロンプトに命名として反映する> を追加しています。");
  });

  it("grounds multi-item create_work replies in committed create and reuse facts", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: [
        "3件対応しました。",
        "新規作成: OPT役員チャンネルへの角井さん招待",
        "新規作成: 金澤さんにMTG定例名を確認",
        "AIC-61（金澤さんのChatGPT招待）は既存タスクがあるのでそちらを使います",
      ].join("\n"),
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.95,
              summary: "複数の task 作成と既存 issue 再利用です。",
            },
          },
        },
        {
          toolName: "propose_create_issue",
          details: {
            proposal: {
              commandType: "create_issue",
              planningReason: "single-issue",
              threadParentHandling: "ignore",
              duplicateHandling: "create-new",
              issue: {
                title: "OPT役員チャンネルへの角井さん招待",
                description: "## Slack source\n角井さんを招待する",
                assigneeMode: "leave-unassigned",
              },
              reasonSummary: "新規 task を作成します。",
            },
          },
        },
        {
          toolName: "propose_create_issue",
          details: {
            proposal: {
              commandType: "create_issue",
              planningReason: "single-issue",
              threadParentHandling: "ignore",
              duplicateHandling: "create-new",
              issue: {
                title: "金澤さんにMTG定例名を確認する",
                description: "## Slack source\n収集対象の定例を確認する",
                assigneeMode: "leave-unassigned",
              },
              reasonSummary: "新規 task を作成します。",
            },
          },
        },
        {
          toolName: "propose_link_existing_issue",
          details: {
            proposal: {
              commandType: "link_existing_issue",
              issueId: "AIC-61",
              reasonSummary: "既存の招待タスクがあるため再利用します。",
              evidenceSummary: "linear_search_issues で確認済みです。",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "create-new",
          issue: {
            title: "OPT役員チャンネルへの角井さん招待",
            description: "## Slack source\n角井さんを招待する",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "新規 task を作成します。",
        },
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "create-new",
          issue: {
            title: "金澤さんにMTG定例名を確認する",
            description: "## Slack source\n収集対象の定例を確認する",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "新規 task を作成します。",
        },
        {
          commandType: "link_existing_issue",
          issueId: "AIC-61",
          reasonSummary: "既存の招待タスクがあるため再利用します。",
          evidenceSummary: "linear_search_issues で確認済みです。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.95,
        summary: "複数の task 作成と既存 issue 再利用です。",
      },
    });

    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "issue-86",
        identifier: "AIC-86",
        title: "OPT役員チャンネルへの角井さん招待",
        url: "https://linear.app/kyaukyuai/issue/AIC-86",
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "issue-87",
        identifier: "AIC-87",
        title: "金澤さんにMTG定例名を確認する",
        url: "https://linear.app/kyaukyuai/issue/AIC-87",
        relations: [],
        inverseRelations: [],
      });
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-61",
      identifier: "AIC-61",
      title: "金澤さんのChatGPTプロジェクト招待",
      url: "https://linear.app/kyaukyuai/issue/AIC-61",
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-grounded-create-work",
        messageTs: "msg-grounded-create-work-1",
        userId: "U1",
        text: "各タスクを追加しておいて",
      },
      new Date("2026-03-27T05:46:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toBe(
      "3件対応しました。\n\n"
      + "- 新規作成: AIC-86（OPT役員チャンネルへの角井さん招待） を作成しました\n"
      + "- 新規作成: AIC-87（金澤さんにMTG定例名を確認する） を作成しました\n"
      + "- 既存利用: AIC-61（金澤さんのChatGPTプロジェクト招待）は既存タスクを使います",
    );
    expect(result.reply).not.toContain("そちらを使います");
    expect(result.reply).not.toContain("system log:");
    expect(result.diagnostics?.agent?.committedCommands).toEqual(["create_issue", "create_issue", "link_existing_issue"]);

    const thread = await loadThreadProjection("C0ALAMDRB9V:thread-grounded-create-work");
    expect(thread).toMatchObject({
      childIssueIds: expect.arrayContaining(["AIC-86", "AIC-87"]),
      linkedIssueIds: expect.arrayContaining(["AIC-61"]),
      lastResolvedIssueId: "AIC-61",
    });
  });

  it("handles clear create items now and persists clarification for one fuzzy duplicate", async () => {
    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "残りの ChatGPT プロジェクト招待だけ、既存 task を使うか新規で作るか確認したいです。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.95,
              summary: "2件は新規作成し、1件は duplicate clarification が必要です。",
            },
          },
        },
        {
          toolName: "report_pending_clarification_decision",
          details: {
            pendingClarificationDecision: {
              decision: "new_request",
              persistence: "replace",
              summary: "ChatGPT プロジェクト招待の扱いを確認したいです。",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "create-new",
          issue: {
            title: "OPT役員チャンネルに角井さんを招待する",
            description: "## Slack source\n角井さんを招待する",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "新規 task を作成します。",
        },
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "create-new",
          issue: {
            title: "金澤さんにMTG定例名を確認する",
            description: "## Slack source\n収集対象の定例を確認する",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "新規 task を作成します。",
        },
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "clarify",
          issue: {
            title: "金澤さんのChatGPTのプロジェクト招待",
            description: "## Slack source\n金澤さんのChatGPTのプロジェクト招待",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "近い既存 task があるため確認したいです。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.95,
        summary: "2件は新規作成し、1件は duplicate clarification が必要です。",
      },
      pendingClarificationDecision: {
        decision: "new_request",
        persistence: "replace",
        summary: "ChatGPT プロジェクト招待の扱いを確認したいです。",
      },
    });

    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "issue-61",
        identifier: "AIC-61",
        title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
        url: "https://linear.app/kyaukyuai/issue/AIC-61",
        state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
        relations: [],
        inverseRelations: [],
      }]);
    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "issue-88",
        identifier: "AIC-88",
        title: "OPT役員チャンネルに角井さんを招待する",
        url: "https://linear.app/kyaukyuai/issue/AIC-88",
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "issue-89",
        identifier: "AIC-89",
        title: "金澤さんにMTG定例名を確認する",
        url: "https://linear.app/kyaukyuai/issue/AIC-89",
        relations: [],
        inverseRelations: [],
      });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-grounded-create-work-clarify",
        messageTs: "msg-grounded-create-work-clarify-1",
        userId: "U1",
        text: "各タスクを追加しておいて",
      },
      new Date("2026-03-27T06:59:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toBe(
      "2件対応しました。\n\n"
      + "- 新規作成: AIC-88（OPT役員チャンネルに角井さんを招待する） を作成しました\n"
      + "- 新規作成: AIC-89（金澤さんにMTG定例名を確認する） を作成しました\n\n"
      + "残り1件だけ確認です。「金澤さんのChatGPTのプロジェクト招待」は近い既存 issue があるため、新規で作るか既存を使うか確認したいです。対象 issue ID か「新規で作成」と返してください。",
    );
    expect(result.reply).not.toContain("system log:");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(2);

    const pending = await loadPendingManagerClarification(
      buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-grounded-create-work-clarify"),
      new Date("2026-03-27T06:59:00.000Z"),
    );
    expect(pending).toMatchObject({
      intent: "create_work",
      clarificationReply: expect.stringContaining("残り1件だけ確認です。"),
      missingDecisionSummary: expect.stringContaining("近い既存 issue"),
    });
  });

  it("updates an existing issue parent directly when the user asks for a child-task relation", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-40",
      identifier: "AIC-40",
      title: "コギトをシステム設定・プロンプトに命名として反映する",
      url: "https://linear.app/kyaukyuai/issue/AIC-40",
      parent: {
        id: "parent-39",
        identifier: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      relations: [],
      inverseRelations: [],
    });

    piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
      reply: "AIC-40 を AIC-39 の子 task として反映します。",
      toolCalls: [
        {
          toolName: "report_manager_intent",
          details: {
            intentReport: {
              intent: "create_work",
              confidence: 0.94,
              summary: "既存 issue の親子付け替えです。",
            },
          },
        },
        {
          toolName: "propose_set_issue_parent",
          details: {
            proposal: {
              commandType: "set_issue_parent",
              issueId: "AIC-40",
              parentIssueId: "AIC-39",
              reasonSummary: "AIC-40 を AIC-39 の子 task にする依頼です。",
            },
          },
        },
      ],
      proposals: [
        {
          commandType: "set_issue_parent",
          issueId: "AIC-40",
          parentIssueId: "AIC-39",
          reasonSummary: "AIC-40 を AIC-39 の子 task にする依頼です。",
        },
      ],
      invalidProposalCount: 0,
      intentReport: {
        intent: "create_work",
        confidence: 0.94,
        summary: "既存 issue の親子付け替えです。",
      },
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parent-update",
        messageTs: "msg-parent-update-1",
        userId: "U1",
        text: "AIC-40 を AIC-39 の子タスクとしてください",
      },
      new Date("2026-03-23T01:30:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-40",
        parent: "AIC-39",
      }),
      expect.any(Object),
    );
    expect(result.reply).toContain("AIC-40 を AIC-39 の子 task");
    expect(result.reply).toContain("> system log: AIC-40 を AIC-39 の子 task として反映しました。");

    const thread = await loadThreadProjection("C0ALAMDRB9V:thread-parent-update");
    expect(thread).toMatchObject({
      parentIssueId: "AIC-39",
      childIssueIds: expect.arrayContaining(["AIC-40"]),
      lastResolvedIssueId: "AIC-40",
    });
  });
});
