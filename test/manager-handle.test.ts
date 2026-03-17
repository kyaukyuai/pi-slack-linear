import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildManagerReview, handleManagerMessage } from "../src/lib/manager.js";
import { ensureManagerSystemFiles, loadFollowupsLedger, loadIntakeLedger } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";

const linearMocks = vi.hoisted(() => ({
  searchLinearIssues: vi.fn(),
  createManagedLinearIssue: vi.fn(),
  createManagedLinearIssueBatch: vi.fn(),
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

vi.mock("../src/lib/linear.js", () => ({
  searchLinearIssues: linearMocks.searchLinearIssues,
  createManagedLinearIssue: linearMocks.createManagedLinearIssue,
  createManagedLinearIssueBatch: linearMocks.createManagedLinearIssueBatch,
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
    expect(second.reply).toContain("- AIC-101 / API レート制限の確認 / 担当: y.kakui");
    expect(second.reply).toContain("- AIC-102 / 修正対応 / 担当: y.kakui");
    expect(second.reply).not.toContain("暫定で kyaukyuai に寄せています");
    expect(second.reply).toContain("この thread で進捗・完了・blocked をそのまま返してください");

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
    expect(result.reply).toContain("親 issue は AIC-200 2ヶ月版の見積もり書作成 ほか1件 です。");
    expect(result.reply).toContain("- AIC-201 / 2ヶ月版の見積もり書作成 / 担当: 角井 勇哉");
    expect(result.reply).toContain("- AIC-202 / 4月・5月の2ヶ月間でのクローン成果物の作成 / 担当: 角井 勇哉 / 期限: 2026-05-31");
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
    expect(result.reply).toContain("対象の issue ID を 1 つ指定してください");
    expect(result.reply).toContain("AIC-121");
    expect(result.reply).toContain("AIC-122");
    expect(linearMocks.updateLinearIssueState).not.toHaveBeenCalled();
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
    expect(result.reply).toContain("調べた範囲: Slack thread / 関連 Linear issue / Web");
    expect(result.reply).toContain("次アクション");
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-141",
      expect.stringContaining("## 分かったこと"),
      expect.any(Object),
    );
    expect(linearMocks.addLinearComment).toHaveBeenCalledWith(
      "AIC-141",
      expect.stringContaining("### Web results"),
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
    expect(result.reply).toContain("AIC-242 / API 仕様の確認");
    expect(result.reply).toContain("AIC-243 / 修正方針の整理");
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
    expect(result.reply).toContain("既存の親 issue AIC-11 ログイン画面の不具合修正 配下");
    expect(result.reply).toContain("調査 task AIC-150 調査: ログイン画面の不具合");
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

    expect(morning).toContain("朝の execution review です。");
    expect(morning).toContain("AIC-300");
    expect(morning).toContain("確認したいこと:");

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
});
