import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/lib/config.js";
import { DEFAULT_HEARTBEAT_PROMPT } from "../src/lib/heartbeat.js";
import { createLinearCustomTools } from "../src/lib/linear-tools.js";
import {
  buildAgentPrompt,
  buildFollowupResolutionPrompt,
  buildResearchSynthesisPrompt,
  buildTaskPlanningPrompt,
  buildSystemPrompt,
  parseFollowupResolutionReply,
  parseResearchSynthesisReply,
  parseTaskPlanningReply,
  type ThreadPromptContext,
} from "../src/lib/pi-session.js";
import type { ThreadPaths } from "../src/lib/thread-workspace.js";

const config: AppConfig = {
  slackAppToken: "xapp-test",
  slackBotToken: "xoxb-test",
  slackAllowedChannelIds: new Set(["C0ALAMDRB9V"]),
  anthropicApiKey: "anthropic-test",
  linearApiKey: "lin_api_test",
  linearWorkspace: "kyaukyuai",
  linearTeamKey: "AIC",
  botModel: "claude-sonnet-4-6",
  workspaceDir: "/tmp/pi-slack-linear",
  heartbeatIntervalMin: 30,
  heartbeatActiveLookbackHours: 24,
  schedulerPollSec: 30,
  logLevel: "info",
};

const threadPaths: ThreadPaths = {
  rootDir: "/tmp/pi-slack-linear/threads/C0ALAMDRB9V/12345",
  sessionFile: "/tmp/pi-slack-linear/threads/C0ALAMDRB9V/12345/session.jsonl",
  logFile: "/tmp/pi-slack-linear/threads/C0ALAMDRB9V/12345/log.jsonl",
  attachmentsDir: "/tmp/pi-slack-linear/threads/C0ALAMDRB9V/12345/attachments",
  scratchDir: "/tmp/pi-slack-linear/threads/C0ALAMDRB9V/12345/scratch",
};

describe("prompt helpers", () => {
  it("states Slack-first execution rules in the system prompt", () => {
    const prompt = buildSystemPrompt(config);

    expect(prompt).toContain("Slack thread is the primary operator surface for day-to-day work.");
    expect(prompt).toContain("Only use the control room for proactive reviews, urgent follow-ups, and fallback-owner notices.");
    expect(prompt).toContain("Prefer existing work in this order: thread-linked issue, existing parent issue, existing duplicate, then new issue.");
    expect(prompt).toContain("For progress, completion, and blocked signals, prefer the most specific child issue over the parent issue.");
    expect(prompt).toContain("When research is required, save detailed findings to Linear and return only a short summary and next action to Slack.");
  });

  it("embeds thread-linked issue context into the runtime prompt", () => {
    const context: ThreadPromptContext = {
      lastResolvedIssueId: "AIC-17",
      parentIssueId: "AIC-11",
      childIssueIds: ["AIC-17", "AIC-18"],
      duplicateReuse: true,
      pendingClarification: true,
      preferredIssueIds: ["AIC-17", "AIC-18", "AIC-11"],
      candidateIssues: [
        { issueId: "AIC-17", title: "調査: ログイン画面の不具合" },
        { issueId: "AIC-11", title: "ログイン画面の不具合修正" },
      ],
    };

    const prompt = buildAgentPrompt(
      {
        channelId: "C0ALAMDRB9V",
        userId: "U123",
        text: "進捗です。原因は再現できています",
        rootThreadTs: "12345.678",
        intent: "task_request",
        attachments: [],
      },
      config,
      threadPaths,
      context,
    );

    expect(prompt).toContain("Thread-linked issue context:");
    expect(prompt).toContain("- lastResolvedIssueId: AIC-17");
    expect(prompt).toContain("- parentIssueId: AIC-11");
    expect(prompt).toContain("- childIssueIds: AIC-17, AIC-18");
    expect(prompt).toContain("- duplicateReuse: yes");
    expect(prompt).toContain("- pendingClarification: yes");
    expect(prompt).toContain("- preferredIssueIds: AIC-17, AIC-18, AIC-11");
    expect(prompt).toContain("- AIC-17 / 調査: ログイン画面の不具合");
    expect(prompt).toContain("- AIC-11 / ログイン画面の不具合修正");
  });

  it("defines an issue-centric heartbeat prompt", () => {
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("Return at most one issue-centric update.");
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("what the team should reply with in the control room");
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("Only consider overdue, due today, blocked, or important stale work.");
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain("HEARTBEAT_OK");
  });

  it("tightens tool guidance for manager flows", () => {
    const tools = createLinearCustomTools(config);
    const searchTool = tools.find((tool) => tool.name === "linear_search_issues");
    const getIssueTool = tools.find((tool) => tool.name === "linear_get_issue");
    const riskyTool = tools.find((tool) => tool.name === "linear_list_risky_issues");
    const threadContextTool = tools.find((tool) => tool.name === "slack_get_thread_context");
    const webSearchTool = tools.find((tool) => tool.name === "web_search_fetch");

    expect(searchTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        "Use this before creating tracked work.",
        "Use this for research requests too, so existing parent issues can be reused.",
      ]),
    );
    expect(getIssueTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        "Use this before status updates when the thread may contain multiple parent and child issues.",
      ]),
    );
    expect(riskyTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        "Treat blocked as blocked state or blocked-by dependency; do not treat plain outgoing blocks relations as blocked.",
      ]),
    );
    expect(threadContextTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        "Use this before research or planning, not for every message.",
      ]),
    );
    expect(webSearchTool?.promptGuidelines).toEqual(
      expect.arrayContaining([
        "Use this only when research is required.",
      ]),
    );
  });

  it("builds and parses research synthesis prompts", () => {
    const prompt = buildResearchSynthesisPrompt({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      taskTitle: "ログイン画面の不具合調査",
      sourceMessage: "ログイン画面の不具合を調査して",
      slackThreadSummary: "- [user] ログイン画面の不具合を調査して",
      recentChannelSummary: "- 12345.678: ログイン画面関連の相談",
      relatedIssuesSummary: "- AIC-11 / ログイン画面の不具合修正 / Started",
      webSummary: "- Login troubleshooting\n  - URL: https://example.com/login",
      taskKey: "AIC-17",
    });

    expect(prompt).toContain("Reply with a single JSON object only.");
    expect(prompt).toContain("taskTitle: ログイン画面の不具合調査");
    expect(prompt).toContain("Related Linear issues:");

    const parsed = parseResearchSynthesisReply(`\`\`\`json
{"findings":["関連 issue を確認しました。"],"uncertainties":["対処方針の確定が必要です。"],"nextActions":[{"title":"API 仕様の確認","purpose":"仕様差分を確認する","confidence":0.8},{"title":"修正方針の整理","purpose":"方針を整理する","confidence":0.7}]}
\`\`\``);

    expect(parsed).toEqual({
      findings: ["関連 issue を確認しました。"],
      uncertainties: ["対処方針の確定が必要です。"],
      nextActions: [
        { title: "API 仕様の確認", purpose: "仕様差分を確認する", confidence: 0.8 },
        { title: "修正方針の整理", purpose: "方針を整理する", confidence: 0.7 },
      ],
    });
  });

  it("builds and parses task planning prompts", () => {
    const prompt = buildTaskPlanningPrompt({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      originalRequest: "OPT社と金澤クローンAI開発の契約を締結する必要があります。",
      latestUserMessage: "ドラフト版作成後、OPT 田平さんに確認依頼する必要あり",
      combinedRequest: "OPT社と金澤クローンAI開発の契約を締結する必要があります。\n契約書のドラフト版の作成依頼済み\nドラフト版作成後、OPT 田平さんに確認依頼する必要あり",
      clarificationQuestion: undefined,
      currentDate: "2026-03-18",
    });

    expect(prompt).toContain("Reply with a single JSON object only.");
    expect(prompt).toContain('"planningReason":"single-issue"|"complex-request"|"research-first"');
    expect(prompt).toContain('Example normalization: "契約書のドラフト版の作成依頼済み" -> "ドラフト作成".');

    const parsed = parseTaskPlanningReply(`\`\`\`json
{"action":"create","planningReason":"complex-request","parentTitle":"OPT社と金澤クローンAI開発の契約締結","parentDueDate":null,"children":[{"title":"ドラフト作成","kind":"execution","dueDate":null},{"title":"OPT 田平さんへ契約書確認依頼","kind":"execution","dueDate":null,"assigneeHint":"OPT 田平さん"}]}
\`\`\``);

    expect(parsed).toEqual({
      action: "create",
      planningReason: "complex-request",
      parentTitle: "OPT社と金澤クローンAI開発の契約締結",
      parentDueDate: undefined,
      children: [
        { title: "ドラフト作成", kind: "execution", dueDate: undefined, assigneeHint: undefined },
        { title: "OPT 田平さんへ契約書確認依頼", kind: "execution", dueDate: undefined, assigneeHint: "OPT 田平さん" },
      ],
    });
  });

  it("builds and parses follow-up resolution prompts", () => {
    const prompt = buildFollowupResolutionPrompt({
      issueId: "AIC-123",
      issueTitle: "ログイン画面の不具合修正",
      requestKind: "blocked-details",
      requestText: "原因と、誰の返答待ちか、何がそろえば再開できるかを共有してください。",
      acceptableAnswerHint: "原因 / 待ち先 / 再開条件",
      responseText: "原因は API 仕様差分です。田平さんの返答待ちで、仕様確定したら再開できます。",
    });

    expect(prompt).toContain("requestKind: blocked-details");
    expect(prompt).toContain("acceptableAnswerHint: 原因 / 待ち先 / 再開条件");

    const parsed = parseFollowupResolutionReply(`\`\`\`json
{"answered":true,"answerKind":"blocked-details","confidence":0.9,"extractedFields":{"blockedReason":"API 仕様差分","waitingOn":"田平さん","resumeCondition":"仕様確定"},"reasoningSummary":"要求された blocked 詳細を満たしています。"}
\`\`\``);

    expect(parsed).toEqual({
      answered: true,
      answerKind: "blocked-details",
      confidence: 0.9,
      extractedFields: {
        blockedReason: "API 仕様差分",
        waitingOn: "田平さん",
        resumeCondition: "仕様確定",
      },
      reasoningSummary: "要求された blocked 詳細を満たしています。",
    });
  });
});
