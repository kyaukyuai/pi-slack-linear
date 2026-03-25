import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitManagerCommandProposals } from "../src/lib/manager-command-commit.js";
import { ensureManagerStateFiles } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { saveThreadNotionPageTarget } from "../src/lib/thread-notion-page-target.js";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
import { recordPlanningOutcome } from "../src/state/workgraph/recorder.js";

const linearMocks = vi.hoisted(() => ({
  addLinearComment: vi.fn(),
  addLinearProgressComment: vi.fn(),
  addLinearRelation: vi.fn(),
  assignLinearIssue: vi.fn(),
  createManagedLinearIssue: vi.fn(),
  createManagedLinearIssueBatch: vi.fn(),
  getLinearIssue: vi.fn(),
  markLinearIssueBlocked: vi.fn(),
  searchLinearIssues: vi.fn(),
  updateManagedLinearIssue: vi.fn(),
  updateLinearIssueState: vi.fn(),
  updateLinearIssueStateWithComment: vi.fn(),
}));

const slackContextMocks = vi.hoisted(() => ({
  getSlackThreadContext: vi.fn(),
}));

const notionMocks = vi.hoisted(() => ({
  archiveNotionPage: vi.fn(),
  createNotionAgendaPage: vi.fn(),
  updateNotionPage: vi.fn(),
}));

vi.mock("../src/lib/linear.js", () => ({
  addLinearComment: linearMocks.addLinearComment,
  addLinearProgressComment: linearMocks.addLinearProgressComment,
  addLinearRelation: linearMocks.addLinearRelation,
  assignLinearIssue: linearMocks.assignLinearIssue,
  createManagedLinearIssue: linearMocks.createManagedLinearIssue,
  createManagedLinearIssueBatch: linearMocks.createManagedLinearIssueBatch,
  getLinearIssue: linearMocks.getLinearIssue,
  markLinearIssueBlocked: linearMocks.markLinearIssueBlocked,
  searchLinearIssues: linearMocks.searchLinearIssues,
  updateManagedLinearIssue: linearMocks.updateManagedLinearIssue,
  updateLinearIssueState: linearMocks.updateLinearIssueState,
  updateLinearIssueStateWithComment: linearMocks.updateLinearIssueStateWithComment,
}));

vi.mock("../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
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

describe("manager command commit", () => {
  let workspaceDir: string;
  let repositories: ReturnType<typeof createFileBackedManagerRepositories>;
  const config = {
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
    workspaceDir = await mkdtemp(join(tmpdir(), "manager-command-commit-"));
    const systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);
    repositories = createFileBackedManagerRepositories(systemPaths);

    linearMocks.addLinearComment.mockReset();
    linearMocks.addLinearProgressComment.mockReset();
    linearMocks.addLinearRelation.mockReset();
    linearMocks.assignLinearIssue.mockReset();
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.getLinearIssue.mockReset();
    linearMocks.markLinearIssueBlocked.mockReset();
    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.updateManagedLinearIssue.mockReset();
    linearMocks.updateLinearIssueState.mockReset();
    linearMocks.updateLinearIssueStateWithComment.mockReset();
    notionMocks.archiveNotionPage.mockReset();
    notionMocks.createNotionAgendaPage.mockReset();
    notionMocks.updateNotionPage.mockReset();
    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-default",
      entries: [],
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("rejects ambiguous status updates before issuing external writes", async () => {
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-19T02:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-ambiguous-update",
        messageTs: "seed-msg-1",
      },
      messageFingerprint: "ambiguous update seed",
      childIssues: [
        { issueId: "AIC-951", title: "親承認の確認", kind: "execution" },
        { issueId: "AIC-952", title: "文面の反映", kind: "execution" },
      ],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-951",
      originalText: "複数 task の起票",
    });

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-952",
          signal: "progress",
          reasonSummary: "この thread の更新と判断しました。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-ambiguous-update",
        messageTs: "msg-ambiguous-1",
        userId: "U1",
        text: "進捗です。確認依頼は出しました",
      },
      now: new Date("2026-03-19T02:05:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("issue ID");
    expect(linearMocks.addLinearProgressComment).not.toHaveBeenCalled();
  });

  it("rejects owner follow-up resolutions without an assignee", async () => {
    await writeFile(
      buildSystemPaths(workspaceDir).followupsFile,
      `${JSON.stringify([
        {
          issueId: "AIC-960",
          requestKind: "owner",
          status: "awaiting-response",
          requestText: "担当者を共有してください。",
        },
      ], null, 2)}\n`,
      "utf8",
    );

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "resolve_followup",
          issueId: "AIC-960",
          answered: true,
          confidence: 0.92,
          requestKind: "owner",
          responseText: "担当は確認中です。",
          reasonSummary: "follow-up に返答があったと判断しました。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-followup-owner",
        messageTs: "msg-followup-1",
        userId: "U1",
        text: "担当は確認中です",
      },
      now: new Date("2026-03-19T03:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("担当者名");
    expect(linearMocks.getLinearIssue).not.toHaveBeenCalled();
  });

  it("commits completed status updates with a single update-and-comment call", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-501",
      title: "完了済み task",
      state: { id: "state-done", name: "Done", type: "completed" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-501",
          signal: "completed",
          reasonSummary: "完了報告です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-completed",
        messageTs: "msg-completed-1",
        userId: "U1",
        text: "AIC-501 は終わりました",
      },
      now: new Date("2026-03-23T01:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-501",
        state: "completed",
        comment: expect.stringContaining("## Completion source"),
      }),
      expect.any(Object),
    );
    expect(linearMocks.addLinearComment).not.toHaveBeenCalled();
  });

  it("normalizes cancel aliases to Canceled and avoids completed wording in the reply", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-60",
      identifier: "AIC-60",
      title: "金澤さんをChatGPTプロジェクトに招待する",
      state: { id: "state-canceled", name: "Canceled", type: "canceled" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-60",
          signal: "completed",
          state: "Cancelled",
          reasonSummary: "削除依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-cancel-alias",
        messageTs: "msg-cancel-alias-1",
        userId: "U1",
        text: "AIC-60 は削除しておいて",
      },
      now: new Date("2026-03-25T01:06:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-60",
        state: "Canceled",
        comment: expect.stringContaining("## Completion source"),
      }),
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("Canceled に変更しました。");
    expect(result.committed[0]?.summary).not.toContain("完了として反映しました。");
  });

  it("commits progress updates with a due date in one update call and records the new due date", async () => {
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-38",
      identifier: "AIC-38",
      title: "OPT社の社内チャネルへの招待依頼",
      dueDate: "2026-03-27",
      state: { id: "state-started", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "update_issue_status",
          issueId: "AIC-38",
          signal: "progress",
          dueDate: "2026-03-27",
          reasonSummary: "今週を目処に完了予定です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-due-date",
        messageTs: "msg-progress-due-date-1",
        userId: "U1",
        text: "AIC-38 は今週を目処に完了させます",
      },
      now: new Date("2026-03-23T00:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-38",
        dueDate: "2026-03-27",
        comment: expect.stringContaining("## Progress update"),
      }),
      expect.any(Object),
    );
    expect(linearMocks.addLinearProgressComment).not.toHaveBeenCalled();
    expect(result.committed[0]?.summary).toContain("期限は 2026-03-27 として反映しました。");

    const projection = await repositories.workgraph.project();
    expect(projection.issues["AIC-38"]).toMatchObject({
      dueDate: "2026-03-27",
      lastStatus: "progress",
    });
  });

  it("inherits the thread parent for single issue creation proposals", async () => {
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-23T00:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-create",
        messageTs: "seed-parent-1",
      },
      messageFingerprint: "seed parent",
      parentIssue: {
        issueId: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      parentIssueId: "AIC-39",
      childIssues: [],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-39",
      originalText: "親 issue を作成",
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

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
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
          reasonSummary: "既存親の子 task と判断しました。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-create",
        messageTs: "msg-parented-create-1",
        userId: "U1",
        text: "issue 化してください",
      },
      now: new Date("2026-03-23T00:05:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: "AIC-39",
        title: "コギトをシステム設定・プロンプトに命名として反映する",
      }),
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("親は AIC-39 AIマネージャーを実用レベルへ引き上げる");
    expect(result.committed[0]?.summary).toContain("子 task として <https://linear.app/kyaukyuai/issue/AIC-40|AIC-40 コギトをシステム設定・プロンプトに命名として反映する> を追加しています。");
    expect(result.committed[0]?.summary).not.toContain("担当が未定義だった task は、いったん kyaukyuai に寄せています。");
  });

  it("commits multiple create_issue_batch proposals in the same turn without tripping thread dedupe", async () => {
    linearMocks.createManagedLinearIssueBatch
      .mockResolvedValueOnce({
        parent: {
          id: "issue-parent-1",
          identifier: "AIC-201",
          title: "議事録タスク：角井 勇哉（2026-03-24）",
          url: "https://linear.app/kyaukyuai/issue/AIC-201",
          relations: [],
          inverseRelations: [],
        },
        children: [
          {
            id: "issue-child-1",
            identifier: "AIC-202",
            title: "3ヶ月後のゴールとスケジュールのポンチ絵資料作成",
            url: "https://linear.app/kyaukyuai/issue/AIC-202",
            relations: [],
            inverseRelations: [],
          },
          {
            id: "issue-child-2",
            identifier: "AIC-203",
            title: "千島さんとの契約・予算の詳細詰め",
            url: "https://linear.app/kyaukyuai/issue/AIC-203",
            relations: [],
            inverseRelations: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        parent: {
          id: "issue-parent-2",
          identifier: "AIC-204",
          title: "議事録タスク：田平 誠人（2026-03-24）",
          url: "https://linear.app/kyaukyuai/issue/AIC-204",
          relations: [],
          inverseRelations: [],
        },
        children: [
          {
            id: "issue-child-3",
            identifier: "AIC-205",
            title: "金澤さんから定例ミーティング名の確認",
            url: "https://linear.app/kyaukyuai/issue/AIC-205",
            relations: [],
            inverseRelations: [],
          },
        ],
      });

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "create_issue_batch",
          planningReason: "complex-request",
          reasonSummary: "議事録から角井担当 task を作成します。",
          parent: {
            title: "議事録タスク：角井 勇哉（2026-03-24）",
            description: "角井担当 task 群です。",
            assigneeMode: "assign",
            assignee: "y.kakui",
          },
          children: [
            {
              title: "3ヶ月後のゴールとスケジュールのポンチ絵資料作成",
              description: "資料作成 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
            {
              title: "千島さんとの契約・予算の詳細詰め",
              description: "契約・予算 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
          ],
        },
        {
          commandType: "create_issue_batch",
          planningReason: "complex-request",
          reasonSummary: "議事録から田平担当 task を作成します。",
          parent: {
            title: "議事録タスク：田平 誠人（2026-03-24）",
            description: "田平担当 task 群です。",
            assigneeMode: "leave-unassigned",
          },
          children: [
            {
              title: "金澤さんから定例ミーティング名の確認",
              description: "ミーティング名確認 task です。",
              assigneeMode: "leave-unassigned",
            },
          ],
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-multi-batch-create",
        messageTs: "msg-multi-batch-create-1",
        userId: "U1",
        text: "以下の議事録からタスクを作成して",
      },
      now: new Date("2026-03-24T02:49:59.833Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.rejected).toEqual([]);
    expect(result.committed).toHaveLength(2);
    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledTimes(2);
    expect(result.replySummaries.join("\n")).not.toContain("duplicate intake already recorded for this thread");
  });

  it("surfaces structured batch create partial failures with retry guidance", async () => {
    linearMocks.createManagedLinearIssueBatch.mockRejectedValueOnce(Object.assign(
      new Error("Issue batch creation failed while creating child 2 of 7"),
      {
        createdIdentifiers: ["AIC-201", "AIC-202"],
        createdCount: 2,
        failedStep: {
          stage: "child",
          index: 2,
          total: 7,
          title: "千島さんとの契約・予算の詳細詰め",
        },
        retryHint: "Do not rerun the same batch file unchanged after a partial failure.",
      },
    ));

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "create_issue_batch",
          planningReason: "complex-request",
          reasonSummary: "議事録から角井担当 task を作成します。",
          parent: {
            title: "議事録タスク：角井 勇哉（2026-03-24）",
            description: "角井担当 task 群です。",
            assigneeMode: "assign",
            assignee: "y.kakui",
          },
          children: [
            {
              title: "3ヶ月後のゴールとスケジュールのポンチ絵資料作成",
              description: "資料作成 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
            {
              title: "千島さんとの契約・予算の詳細詰め",
              description: "契約・予算 task です。",
              assigneeMode: "assign",
              assignee: "y.kakui",
            },
          ],
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-batch-create-partial-failure",
        messageTs: "msg-batch-create-partial-failure-1",
        userId: "U1",
        text: "以下の議事録からタスクを作成して",
      },
      now: new Date("2026-03-24T02:49:59.833Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("一括起票の途中で失敗しました。");
    expect(result.rejected[0]?.reason).toContain("作成済み issue: AIC-201, AIC-202。");
    expect(result.rejected[0]?.reason).toContain("失敗箇所: child 2/7 「千島さんとの契約・予算の詳細詰め」。");
    expect(result.rejected[0]?.reason).toContain("再試行時は作成済み issue を除いて残りだけを起票してください。");
  });

  it("reuses and reparents an existing duplicate under the thread parent", async () => {
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt: "2026-03-23T00:00:00.000Z",
      source: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-duplicate",
        messageTs: "seed-parent-2",
      },
      messageFingerprint: "seed duplicate parent",
      parentIssue: {
        issueId: "AIC-39",
        title: "AIマネージャーを実用レベルへ引き上げる",
      },
      parentIssueId: "AIC-39",
      childIssues: [],
      planningReason: "complex-request",
      lastResolvedIssueId: "AIC-39",
      originalText: "親 issue を作成",
    });

    linearMocks.searchLinearIssues.mockResolvedValueOnce([
      {
        id: "issue-40",
        identifier: "AIC-40",
        title: "コギトをシステム設定・プロンプトに命名として反映する",
        url: "https://linear.app/kyaukyuai/issue/AIC-40",
        relations: [],
        inverseRelations: [],
      },
    ]);
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

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "attach",
          duplicateHandling: "reuse-and-attach-parent",
          issue: {
            title: "コギトをシステム設定・プロンプトに命名として反映する",
            description: "## Slack source\nissue 化してください",
            assigneeMode: "leave-unassigned",
          },
          reasonSummary: "既存 issue を再利用します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parented-duplicate",
        messageTs: "msg-parented-duplicate-1",
        userId: "U1",
        text: "issue 化してください",
      },
      now: new Date("2026-03-23T00:06:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      {
        issueId: "AIC-40",
        parent: "AIC-39",
      },
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("既存の issue を親 issue に紐づけ直しました。");
    expect(result.committed[0]?.summary).toContain("親は AIC-39 AIマネージャーを実用レベルへ引き上げる です。");
  });

  it("applies assignee updates when reusing an existing duplicate issue", async () => {
    linearMocks.searchLinearIssues.mockResolvedValueOnce([
      {
        id: "issue-55",
        identifier: "AIC-55",
        title: "契約締結対応",
        url: "https://linear.app/kyaukyuai/issue/AIC-55",
        relations: [],
        inverseRelations: [],
      },
    ]);
    linearMocks.assignLinearIssue.mockResolvedValueOnce({
      id: "issue-55",
      identifier: "AIC-55",
      title: "契約締結対応",
      url: "https://linear.app/kyaukyuai/issue/AIC-55",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          threadParentHandling: "ignore",
          duplicateHandling: "reuse-existing",
          issue: {
            title: "契約締結対応",
            description: "契約締結に向けた対応タスク。",
            assigneeMode: "assign",
            assignee: "y.kakui",
            dueDate: "2026-03-31",
            priority: 2,
          },
          reasonSummary: "既存 issue を再利用しつつ担当を設定します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-assign-duplicate",
        messageTs: "msg-assign-duplicate-1",
        userId: "U1",
        text: "kyaukyuai 担当で良いです",
      },
      now: new Date("2026-03-25T00:58:22.480Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.assignLinearIssue).toHaveBeenCalledWith("AIC-55", "y.kakui", expect.any(Object));
    expect(result.committed[0]?.issueIds).toEqual(["AIC-55"]);
    expect(result.committed[0]?.summary).toContain("同じ内容の issue が見つかったので、新規起票はせず既存の issue に寄せます。");
  });

  it("sets an existing issue parent directly", async () => {
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

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "set_issue_parent",
          issueId: "AIC-40",
          parentIssueId: "AIC-39",
          reasonSummary: "AIC-40 を AIC-39 の子 task にする依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-parent-update",
        messageTs: "msg-parent-update-1",
        userId: "U1",
        text: "AIC-40 を AIC-39 の子タスクとしてください",
      },
      now: new Date("2026-03-23T01:30:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-40",
        parent: "AIC-39",
      }),
      expect.any(Object),
    );
    expect(result.committed[0]?.summary).toContain("AIC-40 を AIC-39 の子 task として反映しました。");

    const projection = await repositories.workgraph.project();
    expect(projection.issues["AIC-40"]).toMatchObject({
      parentIssueId: "AIC-39",
    });
    expect(projection.threads["C0ALAMDRB9V:thread-parent-update"]).toMatchObject({
      parentIssueId: "AIC-39",
      childIssueIds: expect.arrayContaining(["AIC-40"]),
    });
  });

  it("rejects create proposals that omit required decision fields", async () => {
    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "create_issue",
          planningReason: "single-issue",
          issue: {
            title: "曖昧な create",
            description: "## Slack source\n曖昧です",
          },
          reasonSummary: "create したいです。",
        } as unknown as Parameters<typeof commitManagerCommandProposals>[0]["proposals"][number],
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-missing-decisions",
        messageTs: "msg-missing-decisions-1",
        userId: "U1",
        text: "issue を作って",
      },
      now: new Date("2026-03-23T00:08:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("判断に必要な項目が不足");
    expect(result.rejected[0]?.reason).toContain("threadParentHandling");
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
  });

  it("creates a custom scheduler job in jobs.json", async () => {
    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "create_scheduler_job",
          jobId: "daily-task-check",
          prompt: "AIC の期限近い task を確認する",
          kind: "daily",
          time: "09:00",
          reasonSummary: "毎朝の custom scheduler job を追加します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-create",
        messageTs: "msg-scheduler-create-1",
        userId: "U1",
        text: "毎日 09:00 に AIC の期限近い task を確認する job を追加して",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    const jobs = JSON.parse(await readFile(buildSystemPaths(workspaceDir).jobsFile, "utf8")) as Array<Record<string, unknown>>;

    expect(result.committed).toHaveLength(1);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "daily-task-check",
        kind: "daily",
        time: "09:00",
        prompt: "AIC の期限近い task を確認する",
      }),
    ]));
  });

  it("updates and deletes a custom scheduler job", async () => {
    const systemPaths = buildSystemPaths(workspaceDir);
    await writeFile(systemPaths.jobsFile, `${JSON.stringify([
      {
        id: "daily-task-check",
        enabled: true,
        channelId: "C0ALAMDRB9V",
        prompt: "AIC の期限近い task を確認する",
        kind: "daily",
        time: "09:00",
      },
    ], null, 2)}\n`, "utf8");

    const updateResult = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "update_scheduler_job",
          jobId: "daily-task-check",
          time: "17:00",
          reasonSummary: "夕方に移動します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-update",
        messageTs: "msg-scheduler-update-1",
        userId: "U1",
        text: "daily-task-check を 17:00 に変更して",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    const deleteResult = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "delete_scheduler_job",
          jobId: "daily-task-check",
          reasonSummary: "不要になったため削除します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-delete",
        messageTs: "msg-scheduler-delete-1",
        userId: "U1",
        text: "daily-task-check を削除して",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    const jobs = JSON.parse(await readFile(systemPaths.jobsFile, "utf8")) as Array<Record<string, unknown>>;

    expect(updateResult.committed).toHaveLength(1);
    expect(updateResult.committed[0]?.summary).toContain("daily-task-check");
    expect(deleteResult.committed).toHaveLength(1);
    expect(jobs.find((job) => job.id === "daily-task-check")).toBeUndefined();
  });

  it("updates built-in schedule policy and syncs review jobs", async () => {
    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "update_builtin_schedule",
          builtinId: "evening-review",
          enabled: false,
          reasonSummary: "夕方レビューを止めます。",
        },
        {
          commandType: "update_builtin_schedule",
          builtinId: "heartbeat",
          intervalMin: 60,
          activeLookbackHours: 12,
          reasonSummary: "heartbeat cadence を下げます。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-builtin-schedule-update",
        messageTs: "msg-builtin-schedule-update-1",
        userId: "U1",
        text: "夕方レビューを止めて heartbeat を 60分ごとにして",
      },
      now: new Date("2026-03-24T00:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    const policy = JSON.parse(await readFile(buildSystemPaths(workspaceDir).policyFile, "utf8")) as Record<string, unknown>;
    const jobs = JSON.parse(await readFile(buildSystemPaths(workspaceDir).jobsFile, "utf8")) as Array<Record<string, unknown>>;

    expect(result.committed).toHaveLength(2);
    expect(policy).toMatchObject({
      heartbeatEnabled: true,
      heartbeatIntervalMin: 60,
      heartbeatActiveLookbackHours: 12,
      reviewCadence: expect.objectContaining({
        eveningEnabled: false,
      }),
    });
    expect(jobs.find((job) => job.id === "manager-review-evening")).toBeUndefined();
    expect(result.committed.map((entry) => entry.summary).join("\n")).toContain("夕方レビューを停止しました。");
  });

  it("runs a custom scheduler job immediately without changing its next run", async () => {
    const systemPaths = buildSystemPaths(workspaceDir);
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

    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "run_scheduler_job_now",
          jobId: "weekly-notion-agenda-ai-clone",
          reasonSummary: "動作確認のため 1 回だけ即時実行します。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-run-now",
        messageTs: "msg-scheduler-run-now-1",
        userId: "U1",
        text: "weekly-notion-agenda-ai-clone を今すぐ実行して",
      },
      now: new Date("2026-03-24T01:00:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
      runSchedulerJobNow: vi.fn().mockResolvedValue({
        status: "ok",
        persistedSummary: "Notion にアジェンダを作成しました。",
        commitSummary: "Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>",
        executedAt: "2026-03-24T01:00:05.000Z",
      }),
    });

    const jobs = JSON.parse(await readFile(systemPaths.jobsFile, "utf8")) as Array<Record<string, unknown>>;
    const updatedJob = jobs.find((job) => job.id === "weekly-notion-agenda-ai-clone");

    expect(result.committed).toHaveLength(1);
    expect(result.committed[0]?.summary).toContain("Notion agenda created:");
    expect(updatedJob).toMatchObject({
      id: "weekly-notion-agenda-ai-clone",
      nextRunAt: "2026-03-26T00:00:00.000Z",
      lastRunAt: "2026-03-24T01:00:05.000Z",
      lastStatus: "ok",
      lastResult: "Notion にアジェンダを作成しました。",
    });
  });

  it("rejects immediate runs for built-in schedules and unknown custom jobs", async () => {
    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "run_scheduler_job_now",
          jobId: "morning-review",
          reasonSummary: "built-in を即時実行したいです。",
        },
        {
          commandType: "run_scheduler_job_now",
          jobId: "heartbeat",
          reasonSummary: "heartbeat を即時実行したいです。",
        },
        {
          commandType: "run_scheduler_job_now",
          jobId: "missing-custom-job",
          reasonSummary: "存在しない custom job を即時実行したいです。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-scheduler-run-now-reject",
        messageTs: "msg-scheduler-run-now-reject-1",
        userId: "U1",
        text: "朝レビューと heartbeat を今すぐ実行して",
      },
      now: new Date("2026-03-24T01:10:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
      runSchedulerJobNow: vi.fn(),
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected[0]?.reason).toContain("built-in schedule");
    expect(result.rejected[1]?.reason).toContain("built-in schedule");
    expect(result.rejected[2]?.reason).toContain("見つかりませんでした");
  });

  it("creates a Notion agenda under the configured parent page", async () => {
    notionMocks.createNotionAgendaPage.mockResolvedValueOnce({
      id: "notion-page-1",
      object: "page",
      title: "AIクローン会議アジェンダ",
      url: "https://www.notion.so/notion-page-1",
      createdTime: "2026-03-24T00:00:00.000Z",
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
        notionAgendaParentPageId: "parent-page-1",
      },
      repositories,
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "AIクローン会議アジェンダ",
          summary: "キックオフ用の論点整理です。",
          sections: [
            {
              heading: "議題",
              bullets: ["PoC 対象範囲", "役割分担"],
            },
          ],
          reasonSummary: "Notion に会議用アジェンダを作る依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-agenda",
        messageTs: "msg-notion-agenda-1",
        userId: "U1",
        text: "Notion にアジェンダを作って",
      },
      now: new Date("2026-03-24T00:05:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.createNotionAgendaPage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "AIクローン会議アジェンダ",
        parentPageId: "parent-page-1",
        summary: "キックオフ用の論点整理です。",
      }),
      expect.objectContaining({
        NOTION_API_TOKEN: "secret_test",
      }),
    );
    expect(result.committed[0]?.summary).toContain("Notion agenda created:");
    expect(result.committed[0]?.summary).toContain("<https://www.notion.so/notion-page-1|AIクローン会議アジェンダ>");
  });

  it("rejects a Notion agenda proposal when no parent page is configured", async () => {
    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
        notionAgendaParentPageId: undefined,
      },
      repositories,
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "AIクローン会議アジェンダ",
          reasonSummary: "Notion に会議用アジェンダを作る依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-agenda-missing-parent",
        messageTs: "msg-notion-agenda-2",
        userId: "U1",
        text: "Notion にアジェンダを作って",
      },
      now: new Date("2026-03-24T00:06:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("NOTION_AGENDA_PARENT_PAGE_ID");
    expect(notionMocks.createNotionAgendaPage).not.toHaveBeenCalled();
  });

  it("updates a Notion page title and appends content", async () => {
    notionMocks.updateNotionPage.mockResolvedValueOnce({
      id: "notion-page-2",
      object: "page",
      title: "更新後の議事録",
      url: "https://www.notion.so/notion-page-2",
      lastEditedTime: "2026-03-24T01:00:00.000Z",
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
      },
      repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-2",
          mode: "append",
          title: "更新後の議事録",
          summary: "会議後の補足です。",
          sections: [
            {
              heading: "次のアクション",
              bullets: ["担当を確認する"],
            },
          ],
          reasonSummary: "直前の Notion ページに追記する依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-update",
        messageTs: "msg-notion-update-1",
        userId: "U1",
        text: "そのページに追記して",
      },
      now: new Date("2026-03-24T01:02:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-2",
        mode: "append",
        title: "更新後の議事録",
        summary: "会議後の補足です。",
        sections: [
          {
            heading: "次のアクション",
            bullets: ["担当を確認する"],
          },
        ],
      }),
      expect.objectContaining({
        NOTION_API_TOKEN: "secret_test",
      }),
    );
    expect(result.committed[0]?.summary).toContain("Notion page updated:");
    expect(result.committed[0]?.summary).toContain("<https://www.notion.so/notion-page-2|更新後の議事録>");
  });

  it("prefers the current active thread Notion page target over a stale page id for generic follow-ups", async () => {
    const threadPaths = buildThreadPaths(workspaceDir, "C0ALAMDRB9V", "thread-notion-current-target");
    await saveThreadNotionPageTarget(threadPaths, {
      pageId: "notion-page-current",
      title: "2026.03.25 | AIクローンプラットフォーム",
      url: "https://www.notion.so/notion-page-current",
      recordedAt: "2026-03-25T03:00:00.000Z",
    });

    notionMocks.updateNotionPage.mockResolvedValueOnce({
      id: "notion-page-current",
      object: "page",
      title: "2026.03.25 | AIクローンプラットフォーム",
      url: "https://www.notion.so/notion-page-current",
      lastEditedTime: "2026-03-25T03:01:00.000Z",
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
      },
      repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-archived-old",
          mode: "append",
          summary: "決定事項を追記しました。",
          reasonSummary: "同じ thread の Notion ページに決定事項を追記する依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-current-target",
        messageTs: "msg-notion-current-target-1",
        userId: "U1",
        text: "Notion に決定事項を追記しておいて",
      },
      now: new Date("2026-03-25T03:01:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-current",
        mode: "append",
        summary: "決定事項を追記しました。",
      }),
      expect.objectContaining({
        NOTION_API_TOKEN: "secret_test",
      }),
    );
    expect(result.committed[0]?.notionPageTargetEffect).toEqual({
      action: "set-active",
      pageId: "notion-page-current",
      title: "2026.03.25 | AIクローンプラットフォーム",
      url: "https://www.notion.so/notion-page-current",
    });
  });

  it("registers created Notion agenda pages as managed pages", async () => {
    notionMocks.createNotionAgendaPage.mockResolvedValueOnce({
      id: "notion-page-managed",
      object: "page",
      title: "会議アジェンダ",
      url: "https://www.notion.so/notion-page-managed",
      createdTime: "2026-03-24T01:05:00.000Z",
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
        notionAgendaParentPageId: "parent-page-1",
      },
      repositories,
      proposals: [
        {
          commandType: "create_notion_agenda",
          title: "会議アジェンダ",
          reasonSummary: "Notion に agenda を作る依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-managed",
        messageTs: "msg-notion-managed-1",
        userId: "U1",
        text: "Notion に agenda を作って",
      },
      now: new Date("2026-03-24T01:05:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    await expect(repositories.notionPages.load()).resolves.toEqual([
      expect.objectContaining({
        pageId: "notion-page-managed",
        pageKind: "agenda",
        title: "会議アジェンダ",
        url: "https://www.notion.so/notion-page-managed",
        managedBy: "cogito",
      }),
    ]);
  });

  it("replaces one managed Notion section by heading", async () => {
    await repositories.notionPages.save([
      {
        pageId: "notion-page-managed",
        pageKind: "agenda",
        title: "管理ページ",
        url: "https://www.notion.so/notion-page-managed",
        createdAt: "2026-03-24T01:00:00.000Z",
        managedBy: "cogito",
      },
    ]);
    notionMocks.updateNotionPage.mockResolvedValueOnce({
      id: "notion-page-managed",
      object: "page",
      title: "管理ページ",
      url: "https://www.notion.so/notion-page-managed",
      lastEditedTime: "2026-03-24T01:06:00.000Z",
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
      },
      repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-managed",
          mode: "replace_section",
          sectionHeading: "議題",
          bullets: ["優先順位を更新する"],
          reasonSummary: "議題セクションを置き換える依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-replace",
        messageTs: "msg-notion-replace-1",
        userId: "U1",
        text: "議題を更新して",
      },
      now: new Date("2026-03-24T01:06:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.updateNotionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: "notion-page-managed",
        mode: "replace_section",
        sectionHeading: "議題",
        bullets: ["優先順位を更新する"],
      }),
      expect.objectContaining({
        NOTION_API_TOKEN: "secret_test",
      }),
    );
    expect(result.committed[0]?.summary).toContain("Notion section updated:");
  });

  it("rejects replace_section updates for unregistered pages", async () => {
    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
      },
      repositories,
      proposals: [
        {
          commandType: "update_notion_page",
          pageId: "notion-page-unmanaged",
          mode: "replace_section",
          sectionHeading: "議題",
          paragraph: "更新内容です。",
          reasonSummary: "未登録ページを更新したい依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-replace-reject",
        messageTs: "msg-notion-replace-reject-1",
        userId: "U1",
        text: "議題を更新して",
      },
      now: new Date("2026-03-24T01:07:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain("コギト管理ページのみ");
    expect(notionMocks.updateNotionPage).not.toHaveBeenCalled();
  });

  it("archives a Notion page for a delete request", async () => {
    notionMocks.archiveNotionPage.mockResolvedValueOnce({
      id: "notion-page-3",
      object: "page",
      title: "削除対象ページ",
      url: "https://www.notion.so/notion-page-3",
      inTrash: true,
      raw: {},
    });

    const result = await commitManagerCommandProposals({
      config: {
        ...config,
        workspaceDir,
        notionApiToken: "secret_test",
      },
      repositories,
      proposals: [
        {
          commandType: "archive_notion_page",
          pageId: "notion-page-3",
          reasonSummary: "不要になった Notion ページを削除したい依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-notion-archive",
        messageTs: "msg-notion-archive-1",
        userId: "U1",
        text: "そのページを削除して",
      },
      now: new Date("2026-03-24T01:03:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(notionMocks.archiveNotionPage).toHaveBeenCalledWith(
      "notion-page-3",
      expect.objectContaining({
        NOTION_API_TOKEN: "secret_test",
      }),
    );
    expect(result.committed[0]?.summary).toContain("Notion page archived:");
    expect(result.committed[0]?.summary).toContain("<https://www.notion.so/notion-page-3|削除対象ページ>");
  });

  it("updates workspace memory explicitly from durable entries", async () => {
    const result = await commitManagerCommandProposals({
      config: { ...config, workspaceDir },
      repositories,
      proposals: [
        {
          commandType: "update_workspace_memory",
          sourceLabel: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
          entries: [
            {
              category: "people-and-projects",
              summary: "AIクローンプラットフォームプロジェクトはコギトとの協働プロジェクト",
              canonicalText: "AIクローンプラットフォームプロジェクトはコギト社との協働プロジェクトであり、金澤クローンを中心としたPoCが主テーマ。",
            },
            {
              category: "context",
              summary: "初回PoCでは金澤クローンのSlack運用到達を目標にする",
              canonicalText: "初回PoCでは、金澤クローンがSlack上で日常相談に耐える状態まで到達することを目標にする。",
            },
          ],
          reasonSummary: "Notion の概要資料を MEMORY に保存する依頼です。",
        },
      ],
      message: {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-memory-update",
        messageTs: "msg-memory-update-1",
        userId: "U1",
        text: "この資料の概要を MEMORY に保存しておいて",
      },
      now: new Date("2026-03-25T01:14:00.000Z"),
      policy: await repositories.policy.load(),
      env: {
        ...process.env,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "AIC",
      },
    });

    expect(result.committed).toHaveLength(1);
    expect(result.committed[0]?.summary).toContain("Workspace MEMORY を更新しました。");
    expect(result.committed[0]?.summary).toContain("2026.03.10 | AIクローンプラットフォーム 初回会議共有資料");

    const memory = await readFile(buildSystemPaths(workspaceDir).memoryFile, "utf8");
    expect(memory).toContain("AIクローンプラットフォームプロジェクトはコギト社との協働プロジェクト");
    expect(memory).toContain("初回PoCでは、金澤クローンがSlack上で日常相談に耐える状態まで到達することを目標にする。");
  });
});
