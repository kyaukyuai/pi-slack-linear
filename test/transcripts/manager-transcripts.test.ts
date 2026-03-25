import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { classifyManagerQuery, classifyManagerSignal, handleManagerMessage } from "../../src/lib/manager.js";
import { ensureManagerStateFiles } from "../../src/lib/manager-state.js";
import { buildSystemPaths } from "../../src/lib/system-workspace.js";
import { createFileBackedManagerRepositories } from "../../src/state/repositories/file-backed-manager-repositories.js";
import { recordPlanningOutcome } from "../../src/state/workgraph/recorder.js";
import { createDefaultTestManagerAgentTurn } from "../helpers/default-manager-agent-mock.js";
import { loadTranscriptFixture, runTranscriptFixture, type TranscriptTurnFixture } from "../helpers/transcript-harness.js";

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

const piSessionMocks = vi.hoisted(() => ({
  runManagerAgentTurn: vi.fn(),
  runManagerSystemTurn: vi.fn(),
  runMessageRouterTurn: vi.fn(),
  runManagerReplyTurn: vi.fn(),
  runTaskPlanningTurn: vi.fn(),
  runResearchSynthesisTurn: vi.fn(),
  runFollowupResolutionTurn: vi.fn(),
}));

vi.mock("../../src/lib/linear.js", () => ({
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

vi.mock("../../src/lib/slack-context.js", () => ({
  getSlackThreadContext: slackContextMocks.getSlackThreadContext,
  getRecentChannelContext: slackContextMocks.getRecentChannelContext,
}));

vi.mock("../../src/lib/web-research.js", () => ({
  webSearchFetch: webResearchMocks.webSearchFetch,
  webFetchUrl: webResearchMocks.webFetchUrl,
}));

vi.mock("../../src/lib/pi-session.js", () => ({
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

function defaultMessageRouter(input: { messageText: string; threadContext?: { pendingClarification?: boolean } }) {
  const text = input.messageText.trim();
  if (/^(?:おはよう|こんにちは|こんばんは|お疲れさま|おつかれさま)(?:ございます)?[。！!？?]*$/.test(text)) {
    return {
      action: "conversation",
      conversationKind: "greeting",
      confidence: 0.95,
      reasoningSummary: "挨拶です。",
    };
  }
  if (/(?:notion|ノーション).*(?:database|データベース)|(?:database|データベース).*(?:notion|ノーション)/i.test(text)) {
    return {
      action: "query",
      queryKind: "reference-material",
      queryScope: /(?:その|この).*(?:database|データベース)|一覧を(?:見て|確認)/i.test(text) ? "thread-context" : "team",
      confidence: 0.9,
      reasoningSummary: "Notion database の参照依頼です。",
    };
  }
  const queryKind = classifyManagerQuery(text);
  if (queryKind) {
    return {
      action: "query",
      queryKind,
      queryScope: /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/.test(text)
        ? "self"
        : /(?:この件|その件|他には|ほかに|他の)/.test(text) || queryKind === "inspect-work" || queryKind === "recommend-next-step"
          ? "thread-context"
          : "team",
      confidence: 0.9,
      reasoningSummary: "query と判断しました。",
    };
  }
  const signal = classifyManagerSignal(text);
  if (signal === "progress") return { action: "update_progress", confidence: 0.9, reasoningSummary: "進捗更新です。" };
  if (signal === "completed") return { action: "update_completed", confidence: 0.9, reasoningSummary: "完了更新です。" };
  if (signal === "blocked") return { action: "update_blocked", confidence: 0.9, reasoningSummary: "blocked 更新です。" };
  if (signal === "request") return { action: "create_work", confidence: 0.9, reasoningSummary: "新規依頼です。" };
  return { action: "conversation", conversationKind: "other", confidence: 0.6, reasoningSummary: "雑談です。" };
}

function renderMockIssue(issue: Record<string, unknown>): string {
  return `${String(issue.identifier ?? "")} ${String(issue.title ?? "")}`.trim();
}

function defaultManagerReply(input: { kind: string; conversationKind?: string; facts?: Record<string, unknown> }) {
  const facts = input.facts ?? {};
  if (input.kind === "conversation") {
    return {
      reply: input.conversationKind === "greeting"
        ? "こんばんは。確認したいことや進めたい task があれば、そのまま送ってください。"
        : "必要なことがあれば、そのまま続けて送ってください。",
    };
  }
  if (input.kind === "list-active") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    return { reply: ["タスク一覧を確認しました。", ...items.map((item) => `- ${renderMockIssue(item)}`)].join("\n") };
  }
  if (input.kind === "what-should-i-do") {
    const items = Array.isArray(facts.selectedItems) ? facts.selectedItems as Array<Record<string, unknown>> : [];
    const viewerDisplayLabel = typeof facts.viewerDisplayLabel === "string" ? facts.viewerDisplayLabel : undefined;
    return {
      reply: [
        viewerDisplayLabel
          ? `今日まず手を付けるなら ${viewerDisplayLabel} の中では ${renderMockIssue(items[0] ?? {})} から見るのがよさそうです。`
          : `今日まず手を付けるなら ${renderMockIssue(items[0] ?? {})} から見るのがよさそうです。`,
        ...items.map((item) => `- ${renderMockIssue(item)}`),
      ].join("\n"),
    };
  }
  if (input.kind === "inspect-work") {
    const issue = (facts.issue ?? {}) as Record<string, unknown>;
    return { reply: `${renderMockIssue(issue)} の状況を確認しました。` };
  }
  if (input.kind === "recommend-next-step") {
    const issue = (facts.issue ?? {}) as Record<string, unknown>;
    return {
      reply: [
        `${renderMockIssue(issue)} について、次の一手を整理しました。`,
        typeof facts.recentThreadSummary === "string" ? facts.recentThreadSummary : undefined,
        typeof facts.recommendedAction === "string" ? facts.recommendedAction : undefined,
      ].filter(Boolean).join(" "),
    };
  }
  if (input.kind === "reference-material") {
    const referenceItems = Array.isArray(facts.referenceItems) ? facts.referenceItems as Array<Record<string, unknown>> : [];
    if (referenceItems.length === 0) {
      return { reply: "参照できる資料はまだ見当たりませんでした。" };
    }
    return {
      reply: [
        "参照できる資料を確認しました。",
        ...referenceItems.map((item) => `- ${String(item.title ?? item.id ?? "")}`),
      ].join("\n"),
    };
  }
  return { reply: "対応しました。" };
}

function makeActiveIssue(overrides: Record<string, unknown> & { identifier: string; title: string }) {
  return {
    id: `issue-${overrides.identifier}`,
    url: `https://linear.app/kyaukyuai/issue/${overrides.identifier}`,
    assignee: { id: "user-1", displayName: "y.kakui" },
    state: { id: "state-started", name: "Started", type: "started" },
    relations: [],
    inverseRelations: [],
    ...overrides,
  };
}

describe("manager transcript fixtures", () => {
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
    workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-transcript-"));
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
    linearMocks.markLinearIssueBlocked.mockReset().mockResolvedValue({
      issue: { id: "issue-1", identifier: "AIC-100", title: "blocked" },
      blockedStateApplied: true,
    });
    linearMocks.updateLinearIssueState.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-100",
      title: "done",
    });
    linearMocks.updateLinearIssueStateWithComment.mockReset().mockResolvedValue({
      id: "issue-1",
      identifier: "AIC-100",
      title: "done",
    });
    linearMocks.listRiskyLinearIssues.mockReset().mockResolvedValue([]);
    linearMocks.listOpenLinearIssues.mockReset().mockImplementation(async (...args: unknown[]) => linearMocks.listRiskyLinearIssues(...args));
    slackContextMocks.getSlackThreadContext.mockReset().mockResolvedValue({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "thread-transcript",
      entries: [],
    });
    slackContextMocks.getRecentChannelContext.mockReset().mockResolvedValue([]);
    webResearchMocks.webSearchFetch.mockReset().mockResolvedValue([]);
    webResearchMocks.webFetchUrl.mockReset().mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      snippet: "Example snippet",
    });
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
    piSessionMocks.runMessageRouterTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { messageText: string; threadContext?: { pendingClarification?: boolean } }) => defaultMessageRouter(input));
    piSessionMocks.runManagerReplyTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { kind: string; conversationKind?: string; facts?: Record<string, unknown> }) => defaultManagerReply(input));
    piSessionMocks.runTaskPlanningTurn.mockReset().mockImplementation(async (_config: unknown, _paths: unknown, input: { combinedRequest: string }) => defaultTaskPlan(input));
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

  it("replays realistic Slack conversations from transcript fixtures", async () => {
    const scenarioSetup = async (turn: TranscriptTurnFixture): Promise<void> => {
      switch (turn.beforeScenario) {
        case "list-my-work":
          linearMocks.listRiskyLinearIssues.mockResolvedValueOnce([
            makeActiveIssue({
              identifier: "AIC-930",
              title: "今日の優先 task",
              assignee: { id: "user-1", displayName: "y.kakui" },
              dueDate: "2026-03-19",
              priority: 1,
              priorityLabel: "Urgent",
            }),
            makeActiveIssue({
              identifier: "AIC-931",
              title: "他メンバーの task",
              assignee: { id: "user-2", displayName: "t.tahira" },
              dueDate: "2026-03-19",
              priority: 1,
              priorityLabel: "Urgent",
            }),
          ]);
          return;
        case "list-active-followup":
          linearMocks.listRiskyLinearIssues.mockResolvedValueOnce([
            makeActiveIssue({
              identifier: "AIC-930",
              title: "今日の優先 task",
              assignee: { id: "user-1", displayName: "y.kakui" },
              dueDate: "2026-03-19",
              priority: 1,
              priorityLabel: "Urgent",
            }),
            makeActiveIssue({
              identifier: "AIC-931",
              title: "他メンバーの task",
              assignee: { id: "user-2", displayName: "t.tahira" },
              dueDate: "2026-03-20",
              priority: 2,
              priorityLabel: "High",
            }),
          ]);
          return;
        case "agent-prioritize-single-overdue":
          piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
            reply: "今日まず見るなら AIC-38 の対応状況を確認するのがよさそうです。ほかに動いている task は今のところ見当たりません。",
            toolCalls: [
              {
                toolName: "report_manager_intent",
                details: {
                  intentReport: {
                    intent: "query",
                    queryKind: "what-should-i-do",
                    queryScope: "team",
                    confidence: 0.94,
                    summary: "優先順位の確認です。",
                  },
                },
              },
              {
                toolName: "report_query_snapshot",
                details: {
                  querySnapshot: {
                    issueIds: ["AIC-38"],
                    shownIssueIds: ["AIC-38"],
                    remainingIssueIds: [],
                    totalItemCount: 1,
                    replySummary: "今日まず見るなら AIC-38 の対応状況を確認するのがよさそうです。ほかに動いている task は今のところ見当たりません。",
                    scope: "team",
                  },
                },
              },
            ],
            proposals: [],
            invalidProposalCount: 0,
            intentReport: {
              intent: "query",
              queryKind: "what-should-i-do",
              queryScope: "team",
              confidence: 0.94,
              summary: "優先順位の確認です。",
            },
          });
          return;
        case "agent-list-continuation-after-prioritize":
          piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
            reply: "他に動いている task は今のところありません。見ておくべきものは AIC-38 だけです。",
            toolCalls: [
              {
                toolName: "report_manager_intent",
                details: {
                  intentReport: {
                    intent: "query",
                    queryKind: "list-active",
                    queryScope: "thread-context",
                    confidence: 0.92,
                    summary: "直前の一覧の続きです。",
                  },
                },
              },
              {
                toolName: "report_query_snapshot",
                details: {
                  querySnapshot: {
                    issueIds: ["AIC-38"],
                    shownIssueIds: ["AIC-38"],
                    remainingIssueIds: [],
                    totalItemCount: 1,
                    replySummary: "他に動いている task は今のところありません。見ておくべきものは AIC-38 だけです。",
                    scope: "thread-context",
                  },
                },
              },
            ],
            proposals: [],
            invalidProposalCount: 0,
            intentReport: {
              intent: "query",
              queryKind: "list-active",
              queryScope: "thread-context",
              confidence: 0.92,
              summary: "直前の一覧の続きです。",
            },
          });
          return;
        case "create-invite-task":
          linearMocks.createManagedLinearIssue.mockResolvedValueOnce({
            id: "issue-940",
            identifier: "AIC-940",
            title: "OPT社の社内チャネルへの招待依頼",
            url: "https://linear.app/kyaukyuai/issue/AIC-940",
            assignee: { id: "user-1", displayName: "y.kakui" },
            state: { id: "state-started", name: "Started", type: "started" },
            relations: [],
            inverseRelations: [],
          });
          return;
        case "inspect-created-task":
          linearMocks.getLinearIssue.mockResolvedValueOnce({
            id: "issue-940",
            identifier: "AIC-940",
            title: "OPT社の社内チャネルへの招待依頼",
            url: "https://linear.app/kyaukyuai/issue/AIC-940",
            assignee: { id: "user-1", displayName: "y.kakui" },
            state: { id: "state-started", name: "Started", type: "started" },
            dueDate: "2026-03-21",
            relations: [],
            inverseRelations: [],
          });
          return;
        case "recommend-next-step":
          slackContextMocks.getSlackThreadContext.mockResolvedValue({
            channelId: "C0ALAMDRB9V",
            rootThreadTs: "thread-transcript",
            entries: [
              { type: "assistant", text: "招待先を確認したら、そのまま依頼してください。" },
              { type: "user", text: "OPT社に投げる文面の下書きまではできています" },
            ],
          });
          linearMocks.getLinearIssue.mockResolvedValueOnce({
            id: "issue-940",
            identifier: "AIC-940",
            title: "OPT社の社内チャネルへの招待依頼",
            url: "https://linear.app/kyaukyuai/issue/AIC-940",
            assignee: { id: "user-1", displayName: "y.kakui" },
            state: { id: "state-started", name: "Started", type: "started" },
            dueDate: "2026-03-21",
            relations: [],
            inverseRelations: [],
          });
          return;
        case "progress-created-task":
          linearMocks.getLinearIssue.mockResolvedValueOnce({
            id: "issue-940",
            identifier: "AIC-940",
            title: "OPT社の社内チャネルへの招待依頼",
            url: "https://linear.app/kyaukyuai/issue/AIC-940",
            assignee: { id: "user-1", displayName: "y.kakui" },
            state: { id: "state-started", name: "Started", type: "started" },
            dueDate: "2026-03-21",
            relations: [],
            inverseRelations: [],
          });
          return;
        case "ambiguous-progress-rejected":
          await recordPlanningOutcome(createFileBackedManagerRepositories(systemPaths).workgraph, {
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
          piSessionMocks.runManagerAgentTurn.mockResolvedValueOnce({
            reply: "進捗を反映します。",
            toolCalls: [
              {
                toolName: "report_manager_intent",
                details: {
                  intentReport: {
                    intent: "update_progress",
                    confidence: 0.88,
                    summary: "進捗更新です。",
                  },
                },
              },
              {
                toolName: "propose_update_issue_status",
                details: {
                  proposal: {
                    commandType: "update_issue_status",
                    issueId: "AIC-952",
                    signal: "progress",
                    reasonSummary: "この thread の更新と判断しました。",
                  },
                },
              },
            ],
            proposals: [
              {
                commandType: "update_issue_status",
                issueId: "AIC-952",
                signal: "progress",
                reasonSummary: "この thread の更新と判断しました。",
              },
            ],
            invalidProposalCount: 0,
            intentReport: {
              intent: "update_progress",
              confidence: 0.88,
              summary: "進捗更新です。",
            },
          });
          return;
        default:
      }
    };

    const fixtureDir = new URL("./fixtures/", import.meta.url);
    const fixtureNames = (await readdir(fixtureDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort();

    for (const fixtureName of fixtureNames) {
      const loadedFixture = await loadTranscriptFixture(new URL(`./fixtures/${fixtureName}`, import.meta.url).pathname);
      await runTranscriptFixture({
        fixture: loadedFixture,
        systemPaths,
        beforeTurn: scenarioSetup,
        invokeTurn: (message, now) => handleManagerMessage(
          { ...config, workspaceDir },
          systemPaths,
          message,
          now,
        ),
      });
    }
  });
});
