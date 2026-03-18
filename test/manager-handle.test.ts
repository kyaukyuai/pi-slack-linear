import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHeartbeatReviewDecision, buildManagerReview, formatIssueSelectionReply, handleManagerMessage } from "../src/lib/manager.js";
import { ensureManagerSystemFiles, loadFollowupsLedger, loadIntakeLedger } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";

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

const piSessionMocks = vi.hoisted(() => ({
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

vi.mock("../src/lib/pi-session.js", () => ({
  runResearchSynthesisTurn: piSessionMocks.runResearchSynthesisTurn,
  runFollowupResolutionTurn: piSessionMocks.runFollowupResolutionTurn,
}));

describe("handleManagerMessage clarification flow", () => {
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
    botModel: "claude-sonnet-4-5",
    workspaceDir: "",
    heartbeatIntervalMin: 30,
    heartbeatActiveLookbackHours: 24,
    schedulerPollSec: 30,
    logLevel: "info" as const,
  };

  async function updatePolicy(patch: Record<string, unknown>): Promise<void> {
    const raw = await readFile(systemPaths.policyFile, "utf8");
    const current = JSON.parse(raw) as Record<string, unknown>;
    await writeFile(systemPaths.policyFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
  }

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-manager-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerSystemFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset().mockImplementation(async (input: { issueId: string; description?: string }) => ({
      id: input.issueId,
      identifier: input.issueId,
      title: "updated",
      description: input.description,
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.assignLinearIssue.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearComment.mockReset().mockResolvedValue(undefined);
    linearMocks.addLinearProgressComment.mockReset().mockResolvedValue({ id: "comment-1", body: "ok" });
    linearMocks.addLinearRelation.mockReset().mockResolvedValue(undefined);
    linearMocks.getLinearIssue.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-110",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-110",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });
    linearMocks.markLinearIssueBlocked.mockReset().mockResolvedValue({
      issue: { id: "issue-1", identifier: "AIC-100", title: "blocked" },
      blockedStateApplied: true,
    });
    linearMocks.updateLinearIssueState.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-100",
      title: "done",
    });
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-clarify",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
    piSessionMocks.runResearchSynthesisTurn.mockReset().mockResolvedValue({
      findings: ["関連情報の洗い出しを開始しました。"],
      uncertainties: ["スコープや対処方針の確定が必要なら、この thread で詰めます。"],
      nextActions: [],
    });
    piSessionMocks.runFollowupResolutionTurn.mockReset().mockResolvedValue({
      answered: false,
      confidence: 0.3,
      reasoningSummary: "要求に対する返答としてはまだ不十分です。",
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("asks for clarification first, then creates parent and child issues from follow-up details", async () => {
    const first = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-clarify",
        messageTs: "msg-1",
        userId: "U1",
        text: "来週のリリースに向けた対応を進めておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(first.handled).toBe(true);
    expect(first.reply).toContain("起票前に確認したい点があります");
    expect(first.reply).toContain("期限を確認したいです");
    expect(first.reply).toContain("進め方を固めたいです");
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.createManagedLinearIssueBatch).not.toHaveBeenCalled();

    let ledger = await loadIntakeLedger(systemPaths);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe("needs-clarification");

    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-100",
        title: "来週のリリースに向けた対応",
        url: "https://linear.app/kyaukyuai/issue/AIC-100",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-101",
          title: "API レート制限の確認",
          url: "https://linear.app/kyaukyuai/issue/AIC-101",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-102",
          title: "修正対応",
          url: "https://linear.app/kyaukyuai/issue/AIC-102",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    const second = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-clarify",
        messageTs: "msg-2",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- API レート制限の確認\n- 修正対応\nに分けて進めて",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(second.handled).toBe(true);
    expect(second.reply).toContain("Linear に登録しました");
    expect(second.reply).toContain("AIC-100");
    expect(second.reply).toContain("対象: AIC-100 来週のリリースに向けた対応");
    expect(second.reply).toContain("子task: AIC-101 API レート制限の確認 / AIC-102 修正対応");
    expect(second.reply).not.toContain("暫定で kyaukyuai に寄せています");
    expect(second.reply).toContain("次アクション: この thread で進捗・完了・blocked を続けてください。");
    expect(second.reply).not.toContain("URL:");

    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledTimes(1);
    expect(linearMocks.assignLinearIssue).not.toHaveBeenCalled();
    expect(linearMocks.addLinearRelation).toHaveBeenCalledWith("AIC-101", "blocks", "AIC-102", expect.any(Object));

    ledger = await loadIntakeLedger(systemPaths);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe("created");
    expect(ledger[0]?.parentIssueId).toBe("AIC-100");
    expect(ledger[0]?.childIssueIds).toEqual(["AIC-101", "AIC-102"]);
  });

  it("updates a unique thread-linked issue when the user reports progress", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-110",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-110",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("進捗を Linear に反映しました");
    expect(result.reply).toContain("AIC-110");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-110",
      expect.stringContaining("進捗です。原因は再現できています"),
      expect.any(Object),
    );

    const ledger = await loadIntakeLedger(systemPaths);
    expect(ledger.at(-1)?.status).toBe("progressed");
    expect(ledger.at(-1)?.lastResolvedIssueId).toBe("AIC-110");
  });

  it("keeps status updates enabled when autoCreate is disabled", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-210",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-210",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-autocreate-off",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    await updatePolicy({
      autoCreate: false,
      autoStatusUpdate: true,
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-progress-autocreate-off",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("進捗を Linear に反映しました");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-210",
      expect.stringContaining("進捗です。原因は再現できています"),
      expect.any(Object),
    );
  });

  it("imports numbered task lists without mangling titles and applies inline assignee metadata", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-200",
        title: "2ヶ月版の見積もり書作成 ほか1件",
        url: "https://linear.app/kyaukyuai/issue/AIC-200",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-201",
          title: "2ヶ月版の見積もり書作成",
          url: "https://linear.app/kyaukyuai/issue/AIC-201",
          assignee: { id: "user-1", displayName: "角井 勇哉" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-202",
          title: "4月・5月の2ヶ月間でのクローン成果物の作成",
          url: "https://linear.app/kyaukyuai/issue/AIC-202",
          assignee: { id: "user-1", displayName: "角井 勇哉" },
          dueDate: "2026-05-31",
          relations: [],
          inverseRelations: [],
        },
      ],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-list-import",
        messageTs: "msg-1",
        userId: "U1",
        text: `3. タスク一覧
1. 2ヶ月版の見積もり書作成（担当：角井 勇哉, 期限：未定）
2. 4月・5月の2ヶ月間でのクローン成果物の作成（担当：角井 勇哉, 期限：2026-05-31）`,
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Linear に登録しました。");
    expect(result.reply).toContain("対象: AIC-200 2ヶ月版の見積もり書作成 ほか1件");
    expect(result.reply).toContain("子task: AIC-201 2ヶ月版の見積もり書作成 / AIC-202 4月・5月の2ヶ月間でのクローン成果物の作成");
    expect(result.reply).not.toContain("暫定で kyaukyuai に寄せています");

    expect(linearMocks.createManagedLinearIssueBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: expect.objectContaining({
          title: "2ヶ月版の見積もり書作成 ほか1件",
          dueDate: undefined,
        }),
        children: [
          expect.objectContaining({
            title: "2ヶ月版の見積もり書作成",
            assignee: "角井 勇哉",
            dueDate: undefined,
          }),
          expect.objectContaining({
            title: "4月・5月の2ヶ月間でのクローン成果物の作成",
            assignee: "角井 勇哉",
            dueDate: "2026-05-31",
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(linearMocks.createManagedLinearIssue).not.toHaveBeenCalled();
  });

  it("asks for an issue id when the thread maps to multiple issues for completion", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-120",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-120",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-121",
          title: "設計",
          url: "https://linear.app/kyaukyuai/issue/AIC-121",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-122",
          title: "実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-122",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-121" ? "設計" : issueId === "AIC-122" ? "実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    }));

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計\n- 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex",
        messageTs: "msg-2",
        userId: "U1",
        text: "終わりました",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("完了を Linear に反映しました。");
    expect(linearMocks.updateLinearIssueState).toHaveBeenCalledWith(
      "AIC-122",
      "completed",
      expect.any(Object),
    );
  });

  it("prefers a matching child issue in a multi-issue thread", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-220",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-220",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-221",
          title: "設計",
          url: "https://linear.app/kyaukyuai/issue/AIC-221",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-222",
          title: "実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-222",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-221" ? "設計" : issueId === "AIC-222" ? "実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    }));
    linearMocks.updateLinearIssueState.mockResolvedValueOnce({
      id: "child-1",
      identifier: "AIC-221",
      title: "設計",
      url: "https://linear.app/kyaukyuai/issue/AIC-221",
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-title-match",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計\n- 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-title-match",
        messageTs: "msg-2",
        userId: "U1",
        text: "設計は終わりました",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("完了を Linear に反映しました");
    expect(result.reply).toContain("AIC-221");
    expect(linearMocks.updateLinearIssueState).toHaveBeenCalledWith("AIC-221", "completed", expect.any(Object));
  });

  it("uses recent thread context to resolve generic progress updates to the right child issue", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-320",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-320",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-321",
          title: "設計整理",
          url: "https://linear.app/kyaukyuai/issue/AIC-321",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-322",
          title: "API 実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-322",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-321" ? "設計整理" : issueId === "AIC-322" ? "API 実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      relations: [],
      inverseRelations: [],
    }));
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-complex-recent-focus",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-complex-recent-focus", text: "API 実装を進めています" },
        { type: "assistant", ts: "2", threadTs: "thread-complex-recent-focus", text: "承知しました" },
        { type: "user", ts: "3", threadTs: "thread-complex-recent-focus", text: "進捗です" },
      ],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-recent-focus",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計整理\n- API 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-complex-recent-focus",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("進捗を Linear に反映しました");
    expect(result.reply).toContain("AIC-322");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-322",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("prefers a child with recent Linear progress comments for generic progress updates", async () => {
    linearMocks.createManagedLinearIssueBatch.mockResolvedValueOnce({
      parent: {
        id: "parent-1",
        identifier: "AIC-420",
        title: "複雑な依頼",
        url: "https://linear.app/kyaukyuai/issue/AIC-420",
        relations: [],
        inverseRelations: [],
      },
      children: [
        {
          id: "child-1",
          identifier: "AIC-421",
          title: "設計整理",
          url: "https://linear.app/kyaukyuai/issue/AIC-421",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "child-2",
          identifier: "AIC-422",
          title: "API 実装",
          url: "https://linear.app/kyaukyuai/issue/AIC-422",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ],
    });
    linearMocks.getLinearIssue.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId,
      title: issueId === "AIC-421" ? "設計整理" : issueId === "AIC-422" ? "API 実装" : "複雑な依頼",
      url: `https://linear.app/kyaukyuai/issue/${issueId}`,
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-1", name: "Started", type: "started" },
      latestActionKind: issueId === "AIC-422" ? "progress" : "other",
      comments: issueId === "AIC-422"
        ? [{ id: "comment-1", body: "## Progress update\nAPI 実装の確認を進めています", createdAt: "2026-03-17T04:01:00.000Z" }]
        : [{ id: "comment-2", body: "## Slack source\n設計整理", createdAt: "2026-03-17T04:01:00.000Z" }],
      relations: [],
      inverseRelations: [],
    }));
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-linear-comment-focus",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-linear-comment-focus", text: "進捗です" },
      ],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-linear-comment-focus",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限は 2026-03-20 で、作業は\n- 設計整理\n- API 実装\nに分けて進めて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-linear-comment-focus",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です",
      },
      new Date("2026-03-17T04:05:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("AIC-422");
    expect(linearMocks.addLinearProgressComment).toHaveBeenCalledWith(
      "AIC-422",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("marks a thread-linked issue as blocked", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-130",
      title: "ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-130",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-blocked",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合修正を対応しておいて",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-blocked",
        messageTs: "msg-2",
        userId: "U1",
        text: "blocked です。API 仕様待ちです",
      },
      new Date("2026-03-17T04:10:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("blocked 状態を Linear に反映しました");
    expect(linearMocks.markLinearIssueBlocked).toHaveBeenCalledWith(
      "AIC-130",
      expect.stringContaining("API 仕様待ちです"),
      expect.any(Object),
    );
  });

  it("includes latest action labels in ambiguity replies", async () => {
    const reply = formatIssueSelectionReply("progress", [
      { issueId: "AIC-431", title: "設計整理", latestActionLabel: "進捗", focusReason: "直近 thread focus" },
      { issueId: "AIC-432", title: "設計検証", latestActionLabel: "blocked", focusReason: "最新 intake entry" },
    ]);

    expect(reply).toContain("AIC-431 / 設計整理 / 最新: 進捗 / 理由: 直近 thread focus");
    expect(reply).toContain("AIC-432 / 設計検証 / 最新: blocked / 理由: 最新 intake entry");
  });

  it("writes a structured research comment for research-first requests", async () => {
    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "parent-1",
        identifier: "AIC-140",
        title: "ログイン画面の不具合調査",
        url: "https://linear.app/kyaukyuai/issue/AIC-140",
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-1",
        identifier: "AIC-141",
        title: "調査: ログイン画面の不具合調査",
        url: "https://linear.app/kyaukyuai/issue/AIC-141",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      });
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "related-1",
          identifier: "AIC-050",
          title: "過去のログイン不具合",
          state: { id: "state-1", name: "Started", type: "started" },
          relations: [],
          inverseRelations: [],
        },
      ]);
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-research",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-research", text: "ログイン画面の不具合を調査して" },
      ],
    });
    slackContextMocks.getRecentChannelContext.mockResolvedValue([
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "another-thread",
        entries: [{ type: "user", ts: "2", threadTs: "another-thread", text: "別件の文脈" }],
      },
    ]);
    webResearchMocks.webSearchFetch.mockResolvedValue([
      { title: "Login troubleshooting", url: "https://example.com/login", snippet: "Search snippet" },
    ]);
    webResearchMocks.webFetchUrl.mockResolvedValue({
      url: "https://example.com/login",
      title: "Login troubleshooting",
      snippet: "Fetched snippet",
    });
    piSessionMocks.runResearchSynthesisTurn.mockResolvedValue({
      findings: ["関連 issue として AIC-050 過去のログイン不具合 を確認しました。"],
      uncertainties: ["スコープや対処方針の確定が必要なら、この thread で詰めます。"],
      nextActions: [{ title: "API 仕様の確認", purpose: "API の差分を確認する", confidence: 0.82 }],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("調査内容を Linear に記録しました");
    expect(result.reply).toContain("分かったこと: 関連 issue として AIC-050 過去のログイン不具合 を確認しました。");
    expect(result.reply).toContain("未確定事項: スコープや対処方針の確定が必要なら、この thread で詰めます。");
    expect(result.reply).toContain("次アクション: API 仕様の確認");
    expect(result.reply).not.toContain("調べた範囲:");
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-141",
      expect.stringContaining("### Web results"),
      expect.any(Object),
    );
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-141",
        description: expect.stringContaining("関連 issue として AIC-050 過去のログイン不具合 を確認しました。"),
      }),
      expect.any(Object),
    );
  });

  it("creates follow-up child issues when research yields concrete next actions", async () => {
    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "parent-1",
        identifier: "AIC-240",
        title: "ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-240",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-1",
        identifier: "AIC-241",
        title: "調査: ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-241",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-2",
        identifier: "AIC-242",
        title: "API 仕様の確認",
        url: "https://linear.app/kyaukyuai/issue/AIC-242",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-3",
        identifier: "AIC-243",
        title: "修正方針の整理",
        url: "https://linear.app/kyaukyuai/issue/AIC-243",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      });
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-research-followups",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-research-followups", text: "ログイン画面の不具合を調査して" },
        { type: "assistant", ts: "2", threadTs: "thread-research-followups", text: "- API 仕様の確認\n- 修正方針の整理" },
      ],
    });
    piSessionMocks.runResearchSynthesisTurn.mockResolvedValue({
      findings: ["API 仕様の確認と修正方針の整理が必要です。"],
      uncertainties: ["仕様の確定が必要です。"],
      nextActions: [
        { title: "API 仕様の確認", purpose: "API 差分を洗い出す", confidence: 0.88 },
        { title: "修正方針の整理", purpose: "修正方針を具体化する", confidence: 0.81 },
      ],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research-followups",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("追加 task を 2 件作成しました");
    expect(result.reply).toContain("子task: AIC-242 API 仕様の確認 / AIC-243 修正方針の整理");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(4);

    const ledger = await loadIntakeLedger(systemPaths);
    expect(ledger.at(-1)?.childIssueIds).toEqual(["AIC-241", "AIC-242", "AIC-243"]);
  });

  it("reuses an existing issue as the parent for research requests", async () => {
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([
        {
          id: "parent-research",
          identifier: "AIC-16",
          title: "調査: ログイン画面の不具合を調査して",
          url: "https://linear.app/kyaukyuai/issue/AIC-16",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
        {
          id: "parent-existing",
          identifier: "AIC-11",
          title: "ログイン画面の不具合修正",
          url: "https://linear.app/kyaukyuai/issue/AIC-11",
          assignee: { id: "user-1", displayName: "y.kakui" },
          relations: [],
          inverseRelations: [],
        },
      ])
      .mockResolvedValueOnce([]);

    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "child-1",
      identifier: "AIC-150",
      title: "調査: ログイン画面の不具合修正",
      url: "https://linear.app/kyaukyuai/issue/AIC-150",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });
    piSessionMocks.runResearchSynthesisTurn.mockResolvedValue({
      findings: ["既存 issue 配下で調査すべきです。"],
      uncertainties: ["詳細な対処方針は未確定です。"],
      nextActions: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research-existing",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("対象: AIC-11 ログイン画面の不具合修正 配下 / AIC-150 調査: ログイン画面の不具合");
    expect(result.reply).toContain("次アクション: 調査結果をもとに必要なら実行 task を追加します。");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(1);
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: "AIC-11",
        title: "調査: ログイン画面の不具合",
      }),
      expect.any(Object),
    );
    expect(linearMocks.assignLinearIssue).not.toHaveBeenCalled();

    const ledger = await loadIntakeLedger(systemPaths);
    expect(ledger.at(-1)?.parentIssueId).toBe("AIC-11");
    expect(ledger.at(-1)?.childIssueIds).toEqual(["AIC-150"]);
  });

  it("adds one explicit follow-up to reviews and suppresses the same issue in heartbeat", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-300",
      title: "期限超過のタスク",
      url: "https://linear.app/kyaukyuai/issue/AIC-300",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });
    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-review-followup",
        messageTs: "msg-review-1",
        userId: "U1",
        text: "期限超過のタスクを対応しておいて",
      },
      new Date("2026-03-17T00:30:00.000Z"),
    );

    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-300",
        title: "期限超過のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);

    const morning = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T01:00:00.000Z"),
    );

    expect(morning?.text).toContain("朝の execution review です。");
    expect(morning?.text).toContain("AIC-300");
    expect(morning?.followup).toEqual(expect.objectContaining({
      issueId: "AIC-300",
      request: "現在の進捗と次アクション、次回更新予定を共有してください。",
      requestKind: "status",
      acceptableAnswerHint: "進捗 / 次アクション / 次回更新予定",
      source: expect.objectContaining({
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-review-followup",
        sourceMessageTs: "msg-review-1",
      }),
    }));

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-300",
        lastCategory: "overdue",
      }),
    ]));

    const heartbeat = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "heartbeat",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    expect(heartbeat).toBeUndefined();
  });

  it("resolves an awaiting follow-up when the same issue receives a progress update", async () => {
    linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "AIC-301",
      title: "期限超過のタスク",
      url: "https://linear.app/kyaukyuai/issue/AIC-301",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    });

    await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-followup-resolve",
        messageTs: "msg-1",
        userId: "U1",
        text: "期限超過のタスクを対応しておいて",
      },
      new Date("2026-03-17T00:30:00.000Z"),
    );

    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-301",
        title: "期限超過のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T01:00:00.000Z"),
    );
    linearMocks.getLinearIssue.mockImplementationOnce(async () => ({
      id: "issue-1",
      identifier: "AIC-301",
      title: "期限超過のタスク",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
    })).mockImplementationOnce(async () => ({
      id: "issue-1",
      identifier: "AIC-301",
      title: "期限超過のタスク",
      assignee: { id: "user-1", displayName: "y.kakui" },
      relations: [],
      inverseRelations: [],
      comments: [
        {
          id: "comment-1",
          body: "## Progress update\n進捗です。原因は再現できています",
          createdAt: "2026-03-17T01:10:00.000Z",
        },
      ],
      latestActionKind: "progress",
      latestActionAt: "2026-03-17T01:10:00.000Z",
    }));

    let followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-301",
        status: "awaiting-response",
      }),
    ]));

    piSessionMocks.runFollowupResolutionTurn.mockResolvedValueOnce({
      answered: true,
      answerKind: "status",
      confidence: 0.82,
      extractedFields: {
        status: "原因は再現できています",
        nextAction: "修正方針の整理",
        nextUpdate: "本日中",
      },
      reasoningSummary: "進捗と次アクションが示されているため、要求に答えています。",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-followup-resolve",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T01:10:00.000Z"),
    );

    expect(result.handled).toBe(true);
    followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-301",
        status: "resolved",
        resolvedReason: "answered",
        lastResponseKind: "followup-response",
        lastResponseText: "進捗です。原因は再現できています",
        resolutionAssessment: expect.objectContaining({
          answered: true,
          confidence: 0.82,
        }),
      }),
    ]));
    expect(followups.find((entry) => entry.issueId === "AIC-301")?.resolvedAt).toBeTruthy();
  });

  it("keeps owner-missing follow-ups unresolved until an assignee is actually set", async () => {
    await writeFile(systemPaths.intakeLedgerFile, `${JSON.stringify([
      {
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-owner-missing",
        sourceMessageTs: "msg-1",
        messageFingerprint: "owner-missing",
        childIssueIds: ["AIC-305"],
        status: "created",
        clarificationReasons: [],
        lastResolvedIssueId: "AIC-305",
        createdAt: "2026-03-17T00:00:00.000Z",
        updatedAt: "2026-03-17T00:00:00.000Z",
      },
    ], null, 2)}\n`);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-305",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "owner_missing",
        status: "awaiting-response",
        requestText: "担当を決めて共有してください。",
      },
    ], null, 2)}\n`);

    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-305",
      identifier: "AIC-305",
      title: "担当未設定の task",
      relations: [],
      inverseRelations: [],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-owner-missing",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。確認を始めました",
      },
      new Date("2026-03-17T01:10:00.000Z"),
    );

    expect(result.handled).toBe(true);
    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-305",
        status: "awaiting-response",
        lastResponseKind: "progress",
      }),
    ]));
  });

  it("keeps a status follow-up unresolved when the reply lacks a next action", async () => {
    await writeFile(systemPaths.intakeLedgerFile, `${JSON.stringify([
      {
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-status-followup",
        sourceMessageTs: "msg-1",
        messageFingerprint: "status-followup",
        childIssueIds: ["AIC-306"],
        status: "created",
        clarificationReasons: [],
        lastResolvedIssueId: "AIC-306",
        createdAt: "2026-03-17T00:00:00.000Z",
        updatedAt: "2026-03-17T00:00:00.000Z",
      },
    ], null, 2)}\n`);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-306",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "stale",
        requestKind: "status",
        requestText: "現在の進捗と次アクション、次回更新予定を共有してください。",
        acceptableAnswerHint: "進捗 / 次アクション / 次回更新予定",
        status: "awaiting-response",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-status-followup",
        sourceMessageTs: "msg-1",
      },
    ], null, 2)}\n`);

    linearMocks.getLinearIssue.mockImplementationOnce(async () => ({
      id: "issue-306",
      identifier: "AIC-306",
      title: "進捗確認待ち task",
      relations: [],
      inverseRelations: [],
    })).mockImplementationOnce(async () => ({
      id: "issue-306",
      identifier: "AIC-306",
      title: "進捗確認待ち task",
      relations: [],
      inverseRelations: [],
      comments: [
        {
          id: "comment-1",
          body: "## Progress update\n進捗です。原因は再現できています",
          createdAt: "2026-03-17T01:20:00.000Z",
        },
      ],
      latestActionKind: "progress",
      latestActionAt: "2026-03-17T01:20:00.000Z",
    }));
    piSessionMocks.runFollowupResolutionTurn.mockResolvedValueOnce({
      answered: false,
      answerKind: "status",
      confidence: 0.42,
      extractedFields: {
        status: "原因は再現できています",
      },
      reasoningSummary: "進捗はあるが、次アクションと次回更新予定が不足しています。",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-status-followup",
        messageTs: "msg-2",
        userId: "U1",
        text: "進捗です。原因は再現できています",
      },
      new Date("2026-03-17T01:20:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("follow-up への返答を受け取りました。");
    expect(result.reply).toContain("引き続き必要な返答");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-306",
        status: "awaiting-response",
        lastResponseKind: "followup-response",
        lastResponseText: "進捗です。原因は再現できています",
        resolutionAssessment: expect.objectContaining({
          answered: false,
          confidence: 0.42,
        }),
      }),
    ]));
  });

  it("re-pings an unresolved follow-up after cooldown and increments the counter", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-302",
        title: "blocked のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);

    await writeFile(systemPaths.intakeLedgerFile, `${JSON.stringify([
      {
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-followup-reping",
        sourceMessageTs: "msg-1",
        messageFingerprint: "followup-reping",
        childIssueIds: ["AIC-302"],
        status: "created",
        clarificationReasons: [],
        lastResolvedIssueId: "AIC-302",
        createdAt: "2026-03-17T00:00:00.000Z",
        updatedAt: "2026-03-17T00:00:00.000Z",
      },
    ], null, 2)}\n`);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T01:00:00.000Z"),
    );

    const review = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "evening-review",
      new Date("2026-03-18T02:30:00.000Z"),
    );

    expect(review?.followup?.issueId).toBe("AIC-302");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-302",
        status: "awaiting-response",
        rePingCount: 1,
      }),
    ]));
  });

  it("does not create follow-up child issues from request text when synthesis has no next actions", async () => {
    linearMocks.createManagedLinearIssue
      .mockResolvedValueOnce({
        id: "parent-1",
        identifier: "AIC-340",
        title: "ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-340",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      })
      .mockResolvedValueOnce({
        id: "child-1",
        identifier: "AIC-341",
        title: "調査: ログイン画面の不具合",
        url: "https://linear.app/kyaukyuai/issue/AIC-341",
        assignee: { id: "user-1", displayName: "y.kakui" },
        relations: [],
        inverseRelations: [],
      });
    linearMocks.searchLinearIssues
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    piSessionMocks.runResearchSynthesisTurn.mockRejectedValueOnce(new Error("synthesis failed"));
    slackContextMocks.getSlackThreadContext.mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-research-fallback",
      entries: [
        { type: "user", ts: "1", threadTs: "thread-research-fallback", text: "ログイン画面の不具合を調査して。API 仕様の確認と修正方針の整理が必要です。" },
      ],
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-research-fallback",
        messageTs: "msg-1",
        userId: "U1",
        text: "ログイン画面の不具合を調査して。API 仕様の確認と修正方針の整理が必要です。",
      },
      new Date("2026-03-17T04:00:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).not.toContain("追加 task を");
    expect(linearMocks.createManagedLinearIssue).toHaveBeenCalledTimes(2);
    expect(linearMocks.updateManagedLinearIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "AIC-341",
        description: expect.stringContaining("## 次アクション"),
      }),
      expect.any(Object),
    );

    const ledger = await loadIntakeLedger(systemPaths);
    expect(ledger.at(-1)?.childIssueIds).toEqual(["AIC-341"]);
  });

  it("returns a heartbeat noop reason when urgent issues are suppressed by cooldown", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-400",
        title: "期限超過のタスク",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-400",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "overdue",
        status: "awaiting-response",
        requestText: "最新状況と次アクション、次回更新予定を共有してください。",
      },
    ], null, 2)}\n`);

    const decision = await buildHeartbeatReviewDecision(
      { ...config, workspaceDir },
      systemPaths,
      new Date("2026-03-17T01:00:00.000Z"),
    );

    expect(decision.review).toBeUndefined();
    expect(decision.reason).toBe("suppressed-by-cooldown");
  });

  it("marks awaiting follow-ups as resolved when the tracked risk disappears", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-401",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "overdue",
        status: "awaiting-response",
        requestText: "最新状況と次アクション、次回更新予定を共有してください。",
      },
    ], null, 2)}\n`);

    const review = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    expect(review?.text).toContain("今日すぐに共有すべきリスクはありません");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-401",
        status: "resolved",
        resolvedReason: "risk-cleared",
      }),
    ]));
  });

  it("marks due-missing follow-ups as resolved only when a due date is set", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-403",
        title: "期限未設定の task",
        dueDate: "2026-03-20",
        updatedAt: "2026-03-17T00:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-403",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "due_missing",
        status: "awaiting-response",
        requestText: "期限が必要なら共有してください。",
      },
    ], null, 2)}\n`);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-403",
        status: "resolved",
        resolvedReason: "risk-cleared",
      }),
    ]));
  });

  it("applies a due-date follow-up reply from the source thread and resolves it as risk-cleared", async () => {
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-404",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "due_missing",
        requestKind: "due-date",
        requestText: "期限を YYYY-MM-DD で共有してください。",
        acceptableAnswerHint: "YYYY-MM-DD",
        status: "awaiting-response",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-due-followup",
        sourceMessageTs: "msg-1",
      },
    ], null, 2)}\n`);
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-404",
      identifier: "AIC-404",
      title: "期限未設定の task",
      relations: [],
      inverseRelations: [],
    });
    linearMocks.updateManagedLinearIssue.mockResolvedValueOnce({
      id: "issue-404",
      identifier: "AIC-404",
      title: "期限未設定の task",
      dueDate: "2026-03-20",
      relations: [],
      inverseRelations: [],
    });
    piSessionMocks.runFollowupResolutionTurn.mockResolvedValueOnce({
      answered: true,
      answerKind: "due-date",
      confidence: 0.92,
      extractedFields: {
        dueDate: "2026-03-20",
      },
      reasoningSummary: "期限が YYYY-MM-DD で指定されています。",
    });

    const result = await handleManagerMessage(
      { ...config, workspaceDir },
      systemPaths,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "thread-due-followup",
        messageTs: "msg-2",
        userId: "U1",
        text: "期限は 2026-03-20 です",
      },
      new Date("2026-03-17T01:30:00.000Z"),
    );

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("期限: 2026-03-20");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-404",
        status: "resolved",
        resolvedReason: "risk-cleared",
      }),
    ]));
  });

  it("does not resolve a follow-up only because the issue remains risky with a different primary category", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "AIC-402",
        title: "期限超過かつ blocked の task",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-10T03:00:00.000Z",
        priority: 1,
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Blocked", type: "started" },
        relations: [],
        inverseRelations: [],
      },
    ]);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-402",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "overdue",
        status: "awaiting-response",
        requestText: "最新状況と次アクション、次回更新予定を共有してください。",
      },
    ], null, 2)}\n`);

    await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-18T02:00:00.000Z"),
    );

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-402",
        status: "awaiting-response",
      }),
    ]));
  });
});
