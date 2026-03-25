import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHeartbeatReviewDecision,
  buildManagerReview,
  classifyManagerSignal,
  handleManagerMessage,
} from "../src/lib/manager.js";
import { ensureManagerStateFiles, loadFollowupsLedger } from "../src/lib/manager-state.js";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";
import { listAwaitingFollowups } from "../src/state/workgraph/queries.js";
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

function stripTaskTitle(text: string): string {
  return text
    .trim()
    .replace(/^<@[^>]+>\s*/, "")
    .replace(/^\s*(?:[-*・•]\s+|\d+[.)]\s+)/, "")
    .replace(/(の)?(タスク|issue|Issue|イシュー|ticket|チケット)(を)?/g, " ")
    .replace(/(しておいて|やっておいて|追加して|作成して|作って|登録して|おいて|お願い(します)?|対応して|進めておいて|進めて)/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/を$/, "")
    .trim();
}

function defaultTaskPlan(input: { combinedRequest: string }): Record<string, unknown> {
  const singleTitle = stripTaskTitle(input.combinedRequest) || "Slack からの依頼";
  return {
    action: "create",
    planningReason: "single-issue",
    parentTitle: null,
    parentDueDate: undefined,
    children: [
      { title: singleTitle, kind: "execution", dueDate: undefined },
    ],
  };
}

function defaultMessageRouter(input: { messageText: string }) {
  const text = input.messageText.trim();
  const signal = classifyManagerSignal(text);
  if (signal === "progress") {
    return { action: "update_progress", confidence: 0.9, reasoningSummary: "進捗更新です。" };
  }
  if (signal === "completed") {
    return { action: "update_completed", confidence: 0.9, reasoningSummary: "完了更新です。" };
  }
  if (signal === "blocked") {
    return { action: "update_blocked", confidence: 0.9, reasoningSummary: "blocked 更新です。" };
  }
  if (signal === "request") {
    return { action: "create_work", confidence: 0.9, reasoningSummary: "新規依頼です。" };
  }
  return {
    action: "conversation",
    conversationKind: "other",
    confidence: 0.6,
    reasoningSummary: "雑談として扱います。",
  };
}

function defaultManagerReply() {
  return { reply: "対応しました。" };
}

function loadThreadProjection(systemPaths: ReturnType<typeof buildSystemPaths>, threadKey: string) {
  return createFileBackedManagerRepositories(systemPaths).workgraph.project().then((projection) => projection.threads[threadKey]);
}

describe("handleManagerMessage review and follow-up flows", () => {
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
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-review-followup-"));
    systemPaths = buildSystemPaths(workspaceDir);
    await ensureManagerStateFiles(systemPaths);

    linearMocks.searchLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.createManagedLinearIssue.mockReset();
    linearMocks.createManagedLinearIssueBatch.mockReset();
    linearMocks.updateManagedLinearIssue.mockReset().mockImplementation(async (input: { issueId: string; dueDate?: string }) => ({
      id: input.issueId,
      identifier: input.issueId,
      title: "updated",
      dueDate: input.dueDate,
      relations: [],
      inverseRelations: [],
    }));
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
    linearMocks.listOpenLinearIssues.mockReset().mockImplementation(async (...args: unknown[]) => linearMocks.listRiskyLinearIssues(...args));

    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-review",
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
    piSessionMocks.runMessageRouterTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { messageText: string }) => defaultMessageRouter(input));
    piSessionMocks.runManagerReplyTurn.mockReset().mockImplementation(async () => defaultManagerReply());
    piSessionMocks.runTaskPlanningTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { combinedRequest: string }) => defaultTaskPlan(input));
    piSessionMocks.runResearchSynthesisTurn.mockReset();
    piSessionMocks.runFollowupResolutionTurn.mockReset().mockResolvedValue({
      answered: false,
      confidence: 0.3,
      reasoningSummary: "要求に対する返答としてはまだ不十分です。",
    });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
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
        priorityLabel: "Urgent",
        cycle: {
          id: "cycle-42",
          number: 42,
          name: "Sprint 42",
        },
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

    expect(morning?.text).toContain("おはようございます。今朝の確認で、優先して見てほしい点があります。");
    expect(morning?.text).toContain("AIC-300");
    expect(morning?.text).toContain("優先度: Urgent");
    expect(morning?.text).toContain("Cycle: Sprint 42");
    expect(morning?.issueLines?.[0]?.riskSummary).toContain("優先度: Urgent");
    expect(morning?.issueLines?.[0]?.riskSummary).toContain("Cycle: Sprint 42");
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
    const workgraphEvents = await createFileBackedManagerRepositories(systemPaths).workgraph.list();
    expect(workgraphEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "followup.resolved",
        issueId: "AIC-301",
        reason: "answered",
      }),
    ]));
  });

  it("keeps owner-missing follow-ups unresolved until an assignee is actually set", async () => {
    const repositories = createFileBackedManagerRepositories(systemPaths);
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-305",
        lastPublicFollowupAt: "2026-03-17T00:30:00.000Z",
        lastCategory: "owner_missing",
        status: "awaiting-response",
        requestText: "担当を決めて共有してください。",
      },
    ], null, 2)}\n`);
    await repositories.workgraph.append([
      {
        type: "planning.child_created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-owner-missing",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-owner-missing",
        sourceMessageTs: "msg-1",
        issueId: "AIC-305",
        title: "担当未設定の task",
        kind: "execution",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-owner-missing",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-owner-missing",
        sourceMessageTs: "msg-1",
        messageFingerprint: "owner-missing",
        childIssueIds: ["AIC-305"],
        planningReason: "single-issue",
        lastResolvedIssueId: "AIC-305",
      },
    ]);

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
    await createFileBackedManagerRepositories(systemPaths).workgraph.append([
      {
        type: "planning.child_created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-status-followup",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-status-followup",
        sourceMessageTs: "msg-1",
        issueId: "AIC-306",
        title: "進捗確認待ち task",
        kind: "execution",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-status-followup",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-status-followup",
        sourceMessageTs: "msg-1",
        messageFingerprint: "status-followup",
        childIssueIds: ["AIC-306"],
        planningReason: "single-issue",
        lastResolvedIssueId: "AIC-306",
      },
    ]);

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
    expect(result.reply).toContain("返答を受け取りました。");
    expect(result.reply).toContain("引き続きこの内容を教えてください。");

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

    await createFileBackedManagerRepositories(systemPaths).workgraph.append([
      {
        type: "planning.child_created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-followup-reping",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-followup-reping",
        sourceMessageTs: "msg-1",
        issueId: "AIC-302",
        title: "blocked のタスク",
        kind: "execution",
      },
      {
        type: "intake.created",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-followup-reping",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-followup-reping",
        sourceMessageTs: "msg-1",
        messageFingerprint: "followup-reping",
        childIssueIds: ["AIC-302"],
        planningReason: "single-issue",
        lastResolvedIssueId: "AIC-302",
      },
    ]);

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

    expect(review?.text).toContain("今日すぐに共有が必要なリスクはありません。");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-401",
        status: "resolved",
        resolvedReason: "risk-cleared",
      }),
    ]));
  });

  it("marks stale completed follow-ups as resolved and removes them from the workgraph awaiting list", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([]);
    linearMocks.getLinearIssue.mockResolvedValueOnce({
      id: "issue-39",
      identifier: "AIC-39",
      title: "AIマネージャーを実用レベルへ引き上げる（〜3/26）",
      url: "https://linear.app/kyaukyuai/issue/AIC-39",
      assignee: { id: "user-1", displayName: "y.kakui" },
      state: { id: "state-done", name: "Done", type: "completed" },
      relations: [],
      inverseRelations: [],
    });
    await writeFile(systemPaths.followupsFile, `${JSON.stringify([
      {
        issueId: "AIC-39",
        lastPublicFollowupAt: "2026-03-24T00:00:47.615Z",
        lastCategory: "due-soon",
        requestKind: "status",
        requestText: "本日中にクローズできる見込みはありますか？",
        status: "awaiting-response",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "manager-review-morning",
        sourceMessageTs: "manager-review-morning",
      },
    ], null, 2)}\n`);
    await createFileBackedManagerRepositories(systemPaths).workgraph.append([
      {
        type: "followup.requested",
        occurredAt: "2026-03-24T00:00:47.615Z",
        threadKey: "C0ALAMDRB9V:manager-review-morning",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "manager-review-morning",
        sourceMessageTs: "manager-review-morning",
        issueId: "AIC-39",
        category: "due-soon",
        requestKind: "status",
      },
    ]);

    const review = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "morning-review",
      new Date("2026-03-25T00:00:00.000Z"),
    );

    expect(review?.text).not.toContain("AIC-39");

    const followups = await loadFollowupsLedger(systemPaths);
    expect(followups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: "AIC-39",
        status: "resolved",
        resolvedReason: "completed",
      }),
    ]));

    const awaiting = await listAwaitingFollowups(createFileBackedManagerRepositories(systemPaths).workgraph);
    expect(awaiting.find((entry) => entry.issueId === "AIC-39")).toBeUndefined();
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

  it("counts pending clarifications from the work graph in weekly review", async () => {
    linearMocks.listRiskyLinearIssues.mockResolvedValue([]);
    await createFileBackedManagerRepositories(systemPaths).workgraph.append([
      {
        type: "intake.clarification_requested",
        occurredAt: "2026-03-17T00:00:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-weekly-clarify",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-weekly-clarify",
        sourceMessageTs: "msg-1",
        messageFingerprint: "weekly-clarify",
        clarificationQuestion: "期限を教えてください。",
        clarificationReasons: ["due_date"],
      },
      {
        type: "followup.requested",
        occurredAt: "2026-03-17T00:10:00.000Z",
        threadKey: "C0ALAMDRB9V:thread-weekly-followup",
        sourceChannelId: "C0ALAMDRB9V",
        sourceThreadTs: "thread-weekly-followup",
        sourceMessageTs: "msg-2",
        issueId: "AIC-450",
        category: "stale",
        requestKind: "status",
      },
    ]);

    const review = await buildManagerReview(
      { ...config, workspaceDir },
      systemPaths,
      "weekly-review",
      new Date("2026-03-17T02:00:00.000Z"),
    );

    expect(review?.text).toContain("未処理の clarification は 1 件です。");
    expect(review?.text).toContain("未回答の follow-up は 1 件です。");
    expect(review?.summaryLines).toContain("未処理の clarification は 1 件です。");
    expect(review?.summaryLines).toContain("未回答の follow-up は 1 件です。");
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
    expect(result.reply).toContain("期限は 2026-03-20 として反映しました。");

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
