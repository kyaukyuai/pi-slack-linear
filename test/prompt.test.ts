import { describe, expect, it } from "vitest";
import {
  buildManagerReplyPrompt,
  parseManagerReplyReply,
  runManagerReplyTurnWithExecutor,
} from "../src/planners/manager-reply/index.js";
import {
  buildMessageRouterPrompt,
  parseMessageRouterReply,
  runMessageRouterTurnWithExecutor,
} from "../src/planners/message-router/index.js";
import {
  buildFollowupResolutionPrompt,
  parseFollowupResolutionReply,
  runFollowupResolutionTurnWithExecutor,
} from "../src/planners/followup-resolution/index.js";
import {
  buildResearchSynthesisPrompt,
  parseResearchSynthesisReply,
  runResearchSynthesisTurnWithExecutor,
} from "../src/planners/research-synthesis/index.js";
import { buildPersonalizationExtractionPrompt } from "../src/planners/personalization-extraction/index.js";
import { buildTaskPlanningPrompt, parseTaskPlanningReply, runTaskPlanningTurnWithExecutor } from "../src/planners/task-intake/index.js";
import type { AppConfig } from "../src/lib/config.js";
import { DEFAULT_HEARTBEAT_PROMPT } from "../src/lib/heartbeat.js";
import { createLinearCustomTools } from "../src/lib/linear-tools.js";
import {
  WEBHOOK_INITIAL_PROPOSAL_HEADING,
  WEBHOOK_INITIAL_PROPOSAL_MARKER,
} from "../src/orchestrators/webhooks/initial-proposal-comment.js";
import {
  buildAgentPrompt,
  buildManagerAgentPrompt,
  buildManagerSystemPromptInput,
  buildSystemPrompt,
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

const threadPaths: ThreadPaths = {
  rootDir: "/tmp/cogito-work-manager/threads/C0ALAMDRB9V/12345",
  sessionFile: "/tmp/cogito-work-manager/threads/C0ALAMDRB9V/12345/session.jsonl",
  logFile: "/tmp/cogito-work-manager/threads/C0ALAMDRB9V/12345/log.jsonl",
  attachmentsDir: "/tmp/cogito-work-manager/threads/C0ALAMDRB9V/12345/attachments",
  scratchDir: "/tmp/cogito-work-manager/threads/C0ALAMDRB9V/12345/scratch",
};

describe("prompt helpers", () => {
  it("states Slack-first execution rules in the system prompt", () => {
    const prompt = buildSystemPrompt(config, "コギト");

    expect(prompt).toContain("Your working name in this workspace is コギト.");
    expect(prompt).toContain("If the user asks your name or how to call you, answer コギト.");
    expect(prompt).toContain("Slack thread is the primary operator surface for day-to-day work.");
    expect(prompt).toContain("Only use the control room for proactive reviews, urgent follow-ups, and fallback-owner notices.");
    expect(prompt).toContain("Use read tools to inspect Linear, workgraph, Slack context, optional Notion reference material, and lightweight web results.");
    expect(prompt).toContain("If runtime workspace AGENTS are provided in the prompt context, treat them as operator-specific operating rules and stable workflow preferences unless they conflict with hardcoded system rules.");
    expect(prompt).toContain("If workspace memory is provided in the prompt context, treat it as operator-specific terminology, project knowledge, durable context, and preferences unless it conflicts with the system rules.");
    expect(prompt).toContain("If a Notion agenda template is provided in the prompt context, prefer it when creating or extending Notion agendas unless the user explicitly overrides it.");
    expect(prompt).toContain("When runKind=webhook-issue-created, default to a best-effort initial proposal comment on the created issue instead of no-op.");
    expect(prompt).toContain("For webhook-issue-created system tasks, first call linear_get_issue_facts for the created issue to inspect raw facts and existing comments before you decide.");
    expect(prompt).toContain("Webhook issue-created processing has no Slack thread context. Use the issue facts you are given plus normal read tools, assume the control room is the only operator surface, and do not ask follow-up questions in webhook mode.");
    expect(prompt).toContain("For webhook-issue-created system tasks, the only allowed mutation proposal is propose_add_comment for the created issue itself.");
    expect(prompt).toContain(`For webhook-issue-created system tasks, if issue facts already show a comment containing the exact marker ${WEBHOOK_INITIAL_PROPOSAL_MARKER}`);
    expect(prompt).toContain(`For webhook-issue-created system tasks, when you propose the initial comment body, start it with the exact marker ${WEBHOOK_INITIAL_PROPOSAL_MARKER} on its own line, then ${WEBHOOK_INITIAL_PROPOSAL_HEADING} on its own line.`);
    expect(prompt).toContain("For webhook-issue-created system tasks, for thin issues do not stop at generalities.");
    expect(prompt).toContain("Use intent=run_task for imperative execution requests on an existing issue such as AIC-123 を進めて, この issue を実行して, or このタスクを進めて.");
    expect(prompt).toContain("For run_task turns, call report_task_execution_decision once with decision=execute or noop");
    expect(prompt).toContain("Do not downgrade an explicit imperative issue execution request such as AIC-123 を実行して or AIC-123 を進めて into intent=query");
    expect(prompt).toContain("If a run_task request has no clear executable manager action, keep the reply short, explain why no executable manager action exists now, and use report_task_execution_decision with decision=noop.");
    expect(prompt).toContain("If a run_task request does have a clear executable manager action, use existing proposal tools only. Do not invent a new side-effect path.");
    expect(prompt).toContain("For run_task replies, say in one or two short sentences why you executed or no-oped, what concrete action you took or skipped, and where the user should look next.");
    expect(prompt).toContain("For run_task execute replies, name the concrete action such as a status update, comment, Notion update, or scheduler change instead of saying only 実行しました.");
    expect(prompt).toContain("For run_task noop replies, avoid vague value-based wording like 実行価値. State the practical reason and, when helpful, one short next step.");
    expect(prompt).toContain("If the target issue for a run_task request is ambiguous, ask for the issue ID instead of guessing.");
    expect(prompt).toContain("If a run_task request is ambiguous and you ask for the issue ID, also use report_pending_clarification_decision with decision=new_request and persistence=replace");
    expect(prompt).toContain("When the user asks about schedules, scheduler jobs, cron-style tasks, morning/evening/weekly review settings, or heartbeat settings, use the dedicated scheduler tools.");
    expect(prompt).toContain("Use intent=query_schedule for schedule inspection, create_schedule for custom job creation, run_schedule for immediate custom job execution, update_schedule for custom job updates or built-in disable/retime changes, and delete_schedule only for custom job deletion.");
    expect(prompt).toContain("Built-in schedules are morning-review, evening-review, weekly-review, and heartbeat.");
    expect(prompt).toContain("Treat a delete request on a built-in schedule as disable, not physical deletion.");
    expect(prompt).toContain("Immediate scheduler execution in this scope is supported only for custom jobs.");
    expect(prompt).toContain("Use propose_run_scheduler_job_now only when the user explicitly asks to run a custom job immediately");
    expect(prompt).toContain("When the user asks to run a built-in schedule immediately, reply briefly that built-in immediate run is not supported in this scope");
    expect(prompt).toContain("If the user does not specify a channel for a custom scheduler job, default it to the control room channel.");
    expect(prompt).toContain("If a pending manager clarification context exists, call report_pending_clarification_decision once and include both decision and persistence.");
    expect(prompt).toContain("Use persistence=keep when the existing pending clarification should stay as-is, replace when this turn should create or overwrite the pending clarification state, and clear when the pending state should be removed.");
    expect(prompt).toContain("For query replies, call report_query_snapshot once with issueIds, shownIssueIds, remainingIssueIds, totalItemCount, replySummary, and scope.");
    expect(prompt).toContain("For reference-material query replies, also include referenceItems in report_query_snapshot with id, title, url, and source for each page, document, or database you surfaced.");
    expect(prompt).toContain("A query reply without report_query_snapshot is unsafe and will be rejected by the manager.");
    expect(prompt).toContain("When the last query context contains referenceItems and the user asks to look deeper into a topic, inspect those stored reference items first before running a broader new search.");
    expect(prompt).toContain("Prefer existing work in this order: thread-linked issue, existing parent issue, existing duplicate, then new issue.");
    expect(prompt).toContain("For single-issue create proposals, decide explicitly whether the issue should stay standalone or attach under the existing thread parent issue.");
    expect(prompt).toContain("Express that decision in propose_create_issue with threadParentHandling=attach or ignore whenever a thread parent issue exists.");
    expect(prompt).toContain("Express that duplicate decision in propose_create_issue with duplicateHandling=reuse-existing, reuse-and-attach-parent, clarify, or create-new.");
    expect(prompt).toContain("When the user explicitly asks to make one existing issue a child task of another existing issue, use propose_set_issue_parent instead of proposing a comment or deferring for confirmation.");
    expect(prompt).toContain("Express that owner decision with assigneeMode=assign or leave-unassigned.");
    expect(prompt).toContain("For Linear issue delete or cancel requests, use propose_update_issue_status with signal=completed and state=Canceled.");
    expect(prompt).toContain("Do not use Cancelled for Linear issue state updates; use the exact state name Canceled.");
    expect(prompt).toContain("For progress, completion, and blocked signals, prefer the most specific child issue over the parent issue.");
    expect(prompt).toContain("When a progress, completed, or blocked update includes a new target completion date, include dueDate in propose_update_issue_status.");
    expect(prompt).toContain("propose_create_issue_batch supports at most 8 child issues per proposal.");
    expect(prompt).toContain("If a request contains more than 8 child tasks, split it into multiple create_issue_batch proposals in the same turn");
    expect(prompt).toContain("If the user says 今週中 or 今週を目処 without a specific date, resolve it to the Friday of the current JST work week unless the user says otherwise.");
    expect(prompt).toContain("In normal Slack replies, describe only the result the user should observe after the manager commit, and never say 提案しました, 準備ができました, or 送る準備ができました for work that commits in the same turn.");
    expect(prompt).toContain("When research is required, save detailed findings to Linear and return only a short summary and next action to Slack.");
    expect(prompt).toContain("If Notion tools are available, use Notion as reference material for specs, notes, and operating context.");
    expect(prompt).toContain("When the user explicitly asks to create an agenda in Notion, use propose_create_notion_agenda instead of creating a Linear issue.");
    expect(prompt).toContain("When the user explicitly asks to update, append to, retitle, archive, or delete a Notion page, use the dedicated Notion page proposal tools instead of creating or updating a Linear issue.");
    expect(prompt).toContain("When the user explicitly asks to save durable knowledge into MEMORY or workspace memory, use propose_update_workspace_memory as the primary path instead of relying only on silent personalization.");
    expect(prompt).toContain("When the user explicitly asks to update, replace, rewrite, edit, or reflect changes into AGENDA_TEMPLATE.md, use intent=update_workspace_config");
    expect(prompt).toContain("workspace_get_agenda_template");
    expect(prompt).toContain("When the user explicitly asks to update, replace, rewrite, edit, or reflect changes into HEARTBEAT.md, use intent=update_workspace_config");
    expect(prompt).toContain("workspace_get_heartbeat_prompt");
    expect(prompt).toContain("When the user explicitly asks to update, change, edit, add to, or delete from owner-map.json, use intent=update_workspace_config");
    expect(prompt).toContain("workspace_get_owner_map");
    expect(prompt).toContain("propose_update_owner_map");
    expect(prompt).toContain("When the user explicitly asks to mention someone and send a Slack message, use intent=post_slack_message");
    expect(prompt).toContain("resolve exactly one target by exact-match on entry.id, linearAssignee, or slackUserId");
    expect(prompt).toContain("Use propose_post_slack_message for exactly one target and one post.");
    expect(prompt).toContain("Do not route AGENDA_TEMPLATE.md, HEARTBEAT.md, or owner-map.json changes through MEMORY saves or silent personalization.");
    expect(prompt).toContain("owner-map updates use a preview-first path in this scope.");
    expect(prompt).toContain("Never reply that direct file editing tools are unavailable for AGENDA_TEMPLATE.md, HEARTBEAT.md, or owner-map.json.");
    expect(prompt).toContain("For explicit MEMORY saves, it is valid to save a structured project snapshot with several entries such as project-overview, members-and-roles, roadmap-and-milestones, terminology, and context.");
    expect(prompt).toContain("For Notion-based MEMORY save requests, call notion_get_page_content first and extract durable project facts, members, roadmap milestones, terminology, preferences, or context from the page content.");
    expect(prompt).toContain("When the user asks to read an entire Notion page or save its overall content into MEMORY, continue calling notion_get_page_content with later startLine values if the current window says more lines are available.");
    expect(prompt).toContain("Do not copy an entire document into MEMORY. Save only stable facts that should persist across future turns.");
    expect(prompt).toContain("For MEMORY, roadmap-and-milestones is only for project-level goals, phases, milestone windows, or durable schedule targets.");
    expect(prompt).toContain("For project-overview, members-and-roles, and roadmap-and-milestones memory entries, always include the project name explicitly.");
    expect(prompt).toContain("For Notion agenda creation, use the configured default parent page unless the user clearly specifies a different Notion parent page.");
    expect(prompt).toContain("A minimal Notion agenda should have a short title and practical sections like 目的, 議題, 確認事項, and 次のアクション.");
    expect(prompt).toContain("For Notion page updates in this scope, use propose_update_notion_page with an explicit pageId");
    expect(prompt).toContain("mode=append or mode=replace_section");
    expect(prompt).toContain("Use mode=append for requests like 追記して");
    expect(prompt).toContain("Use mode=replace_section for requests like 「議題」を更新して");
    expect(prompt).toContain("replace_section is allowed only for Cogito-managed Notion pages.");
    expect(prompt).toContain("Do not propose full content replacement or arbitrary block edits for Notion pages in this scope.");
    expect(prompt).toContain("For Notion page delete requests, use propose_archive_notion_page.");
    expect(prompt).toContain("When the last query context contains Notion page referenceItems and the user says そのページを更新して");
    expect(prompt).toContain("When the thread has a current active Notion page target and the user asks for a generic Notion follow-up");
    expect(prompt).toContain("If the thread has a current active Notion page target, prefer it over stale historical page IDs");
    expect(prompt).toContain("Do not apply Notion page update or archive proposals to notion-database reference items.");
    expect(prompt).toContain("For reference-material replies that mention multiple Notion pages, documents, or databases, use short bullet lines and include markdown links when URLs are available.");
    expect(prompt).toContain("When notion_get_page_content succeeds, summarize the relevant excerpt or page lines instead of saying the content is unavailable.");
    expect(prompt).toContain("notion_get_page_content returns a display window over the extracted page lines, not a hard retrieval limit.");
    expect(prompt).toContain("Do not use web_fetch_url as the primary read path for notion.so links when Notion tools are available.");
    expect(prompt).toContain("If the user re-checks a Notion page or sends the same notion.so URL again, ignore stale earlier summaries about truncated content and re-read it with Notion tools.");
    expect(prompt).toContain("If the user explicitly says database or データベース, treat it as a database-only request unless they also ask for pages.");
    expect(prompt).toContain("A request like Notion の database を検索して is still a query. Do not downgrade it to casual conversation just because the keyword is missing.");
    expect(prompt).toContain("If the user asks to browse or search Notion databases without a keyword, use notion_list_databases before asking a follow-up question.");
    expect(prompt).toContain("When the relevant Notion information is structured in a database, prefer notion_search_databases and notion_query_database over broad page summarization.");
    expect(prompt).toContain("When you surface a Notion database in report_query_snapshot, set the referenceItems source to notion-database.");
    expect(prompt).toContain("If the last query context contains a notion-database reference item and the user says その database を見て or その一覧を確認して, query that database before starting a broader new search.");
    expect(prompt).toContain("Before filtering or sorting a Notion database, call notion_get_database_facts so you know the property names, types, and status/select options.");
    expect(prompt).toContain("Use notion_query_database filterProperty/filterOperator/filterValue when the user narrows a Notion database like 進行中だけ, 自分の担当だけ, or 期限が今週のもの.");
    expect(prompt).toContain("Use notion_query_database sortProperty/sortDirection when the user asks for an order like 期限が近い順 or 更新が新しい順.");
    expect(prompt).toContain("Do not use markdown headings, separator lines, report-style sections, warning icons, or emojis in public Slack replies.");
    expect(prompt).toContain("For scheduled review or heartbeat replies, never use markdown tables, pipe tables, separator lines, or report-style section headings.");
    expect(prompt).toContain("Treat review / heartbeat / webhook summaries as system notifications, not as arbitrary outbound Slack message sends.");
    expect(prompt).toContain("For review / heartbeat / webhook summaries, never mention a person in the summary or issue bullets.");
    expect(prompt).toContain("Only when issuing one explicit follow-up request may you mention at most one target once at the start of that follow-up request.");
    expect(prompt).toContain("For review and heartbeat reasoning, treat any issue with isOpen=false or completedAt set as completed.");
    expect(prompt).toContain("In review and heartbeat turns, treat workgraph awaiting followups as historical context and source-thread hints only.");
    expect(prompt).toContain("If workgraph awaiting followups conflicts with current Linear review facts, trust the current Linear facts");
    expect(prompt).toContain("When review facts include dueRelativeLabel or daysUntilDue, use that relative due wording verbatim");
    expect(prompt).toContain("For scheduled review or heartbeat replies, use only one short opening sentence and do not repeat the same improvement summary");
    expect(prompt).toContain("For schedule-list replies, use short bullets with schedule ids and timing. Do not use markdown tables or wrap schedule ids in backticks.");
    expect(prompt).toContain("When describing schedule status to the user, mention lastRunAt, lastStatus, lastResult, or lastError");
    expect(prompt).toContain("When the user says 毎日 9:00, 毎週火曜, or 30分ごと, convert that into a valid scheduler proposal instead of asking the manager layer to parse it later.");
    expect(prompt).toContain("Treat 〜を今すぐ実行して, 〜のテスト実行をして, and 〜を試しに一度動かして as scheduler immediate-run requests for custom jobs.");
    expect(prompt).toContain("If the user asks what you can do, answer with 4-5 short bullets and a one-line closing invitation.");
    expect(prompt).toContain("For a what-you-can-do reply, cover these implemented capabilities only: Linear task management, existing issue execution through run_task, Notion search/create/update/archive, scheduler inspection and custom-job execution, and review/heartbeat/webhook automation.");
    expect(prompt).toContain("Do not mention unimplemented capabilities in a what-you-can-do reply.");
    expect(prompt).toContain("If the user asks whether you can mention or message another Slack user, interpret it as a question about your own outbound Slack capability");
    expect(prompt).toContain("Current explicit Slack mention-post support is limited to one explicit owner-map-resolved target per turn");
    expect(prompt).toContain("review and heartbeat may mention one assignee in an internal follow-up notification");
    expect(prompt).toContain("If the user says things like 他には / ほかには / 他のタスク after a list or prioritization reply in the same thread");
  });

  it("includes runAtJst in manager system task prompts", () => {
    const prompt = buildManagerSystemPromptInput({
      kind: "evening-review",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "manager-review-evening",
      messageTs: "manager-review-evening",
      text: "manager review: evening",
      currentDate: "2026-03-23",
      runAtJst: "2026-03-23 17:00 JST",
      metadata: {
        reviewKind: "evening-review",
      },
    });

    expect(prompt).toContain("- runAtJst: 2026-03-23 17:00 JST");
  });

  it("supports webhook issue-created system prompts", () => {
    const prompt = buildManagerSystemPromptInput({
      kind: "webhook-issue-created",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "webhook:AIC-123",
      messageTs: "delivery-1",
      text: "Linear issue created webhook context",
      currentDate: "2026-03-24",
      runAtJst: "2026-03-24 12:00 JST",
      metadata: {
        deliveryId: "delivery-1",
        issueIdentifier: "AIC-123",
        trigger: "linear-webhook",
      },
      workspaceAgents: "曖昧な運用依頼はまず最小 action で整える。",
      workspaceMemory: "契約・稟議系は先に依頼先と期限を確認する。",
      agendaTemplate: "## 目的\n- 合意事項",
    });

    expect(prompt).toContain("- runKind: webhook-issue-created");
    expect(prompt).toContain("- runAtJst: 2026-03-24 12:00 JST");
    expect(prompt).toContain("- deliveryId: delivery-1");
    expect(prompt).toContain("- issueIdentifier: AIC-123");
    expect(prompt).toContain("Runtime workspace AGENTS:");
    expect(prompt).toContain("曖昧な運用依頼はまず最小 action で整える。");
    expect(prompt).toContain("Workspace memory:");
    expect(prompt).toContain("契約・稟議系は先に依頼先と期限を確認する。");
    expect(prompt).toContain("Notion agenda template:");
    expect(prompt).toContain("## 目的");
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

  it("adds concise continuation guidance to the manager runtime prompt", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "他にはどのようなタスクがある？",
      currentDate: "2026-03-23",
      lastQueryContext: {
        kind: "what-should-i-do",
        scope: "team",
        userMessage: "今日やるべきタスクある？",
        replySummary: "今日まず見るなら AIC-38 です。",
        issueIds: ["AIC-38"],
        shownIssueIds: ["AIC-38"],
        remainingIssueIds: ["AIC-39"],
        totalItemCount: 2,
        referenceItems: [
          {
            id: "notion-page-1",
            title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
            url: "https://www.notion.so/notion-page-1",
            source: "notion",
          },
        ],
        recordedAt: "2026-03-23T07:54:00.000Z",
      },
      workspaceAgents: "実行結果は理由から先に短く返す。",
      workspaceMemory: "営業案件では先に期限と担当を明確にする。",
      agendaTemplate: "## 目的\n- 背景共有\n## 議題\n- 意思決定事項",
    });

    expect(prompt).toContain("Last query continuation context:");
    expect(prompt).toContain("- kind: what-should-i-do");
    expect(prompt).toContain("- issueIds: AIC-38");
    expect(prompt).toContain("- shownIssueIds: AIC-38");
    expect(prompt).toContain("- remainingIssueIds: AIC-39");
    expect(prompt).toContain("- totalItemCount: 2");
    expect(prompt).toContain("- referenceItems: notion / notion-page-1 / 2026.03.10 | AIクローンプラットフォーム 初回会議共有資料 / https://www.notion.so/notion-page-1");
    expect(prompt).toContain("Runtime workspace AGENTS:");
    expect(prompt).toContain("実行結果は理由から先に短く返す。");
    expect(prompt).toContain("Workspace memory:");
    expect(prompt).toContain("営業案件では先に期限と担当を明確にする。");
    expect(prompt).toContain("Notion agenda template:");
    expect(prompt).toContain("## 目的");
    expect(prompt).toContain("Public reply style hints:");
    expect(prompt).toContain("Do not use markdown headings, separator lines, warning icons, or emojis.");
    expect(prompt).toContain("Treat this as a continuation of the previous list or prioritization reply in the same thread");
    expect(prompt).toContain("If there is only one additional relevant issue or no additional issue, say that plainly in one sentence.");
    expect(prompt).toContain("Continue from the stored last query context (what-should-i-do / team)");
  });

  it("adds JST-aware greeting guidance to the manager runtime prompt", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "おはよう",
      currentDate: "2026-03-19",
      currentDateTimeJst: "2026-03-19 06:36 JST",
    });

    expect(prompt).toContain("currentDateTimeJst: 2026-03-19 06:36 JST");
    expect(prompt).toContain("Greeting hints:");
    expect(prompt).toContain("The latest message is a greeting.");
    expect(prompt).toContain("Choose a natural Japanese greeting that matches currentDateTimeJst (2026-03-19 06:36 JST) in Asia/Tokyo.");
  });

  it("adds capability-query guidance when the latest message asks about Slack mentions", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "kyaukyuai にメンションできる？",
      currentDate: "2026-03-26",
    });

    expect(prompt).toContain("Capability query hints:");
    expect(prompt).toContain("The latest message is a capability question about outbound Slack mention behavior.");
    expect(prompt).toContain("Do not reinterpret this as whether the user can mention the assistant.");
    expect(prompt).toContain("two supported surfaces");
    expect(prompt).toContain("review / heartbeat follow-up mention");
    expect(prompt).toContain("DM, arbitrary channel, multiple targets, and extra mention tokens");
    expect(prompt).toContain("Do not turn this into a generic what-you-can-do bullet list unless the user broadens the question.");
  });

  it("adds Slack post request guidance for explicit mention-send requests", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "y.kakui にメンションして、こんにちはと送って",
      currentDate: "2026-03-26",
    });

    expect(prompt).toContain("Slack post request hints:");
    expect(prompt).toContain("Treat this as intent=post_slack_message.");
    expect(prompt).toContain("workspace_get_owner_map");
    expect(prompt).toContain("destination=current-thread");
    expect(prompt).toContain("propose_post_slack_message");
  });

  it("includes pending manager clarification context for create continuations", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "という意図です",
      currentDate: "2026-03-23",
      pendingClarification: {
        intent: "create_work",
        originalUserMessage: "箇条書きや太文字が Slack にそのまま表示されているので、それを修正するタスクを作成してください。",
        lastUserMessage: "箇条書きや太文字が Slack にそのまま表示されているので、それを修正するタスクを作成してください。",
        clarificationReply: "いまは起票内容を安全に確定できないため、直したい点を 1 文で言い換えるか、親 issue の有無を補足してください。次の返信はこの thread の続きとして扱います。",
        missingDecisionSummary: "判断に必要な項目が不足しているため確定できませんでした。",
        threadParentIssueId: "AIC-39",
        relatedIssueIds: ["AIC-39"],
        recordedAt: "2026-03-23T03:00:00.000Z",
      },
    });

    expect(prompt).toContain("Pending manager clarification context:");
    expect(prompt).toContain("- intent: create_work");
    expect(prompt).toContain("- threadParentIssueId: AIC-39");
    expect(prompt).toContain("- originalUserMessage: 箇条書きや太文字が Slack にそのまま表示されているので、それを修正するタスクを作成してください。");
    expect(prompt).toContain("If the latest message looks like a clarification or intent correction");
  });

  it("includes pending manager confirmation context for owner-map previews", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "どういう変更ですか？",
      currentDate: "2026-03-23",
      pendingConfirmation: {
        kind: "owner-map",
        originalUserMessage: "owner-map に OPT 担当を追加して",
        proposals: [
          {
            commandType: "update_owner_map",
            operation: "upsert-entry",
            entryId: "opt",
            linearAssignee: "t.tahira",
            domains: ["sales"],
            keywords: ["OPT"],
            primary: false,
            reasonSummary: "OPT 担当 mapping を追加する依頼です。",
          },
        ],
        previewSummaryLines: ["entry opt を追加/更新"],
        recordedAt: "2026-03-23T03:20:00.000Z",
      },
    });

    expect(prompt).toContain("Pending manager confirmation context:");
    expect(prompt).toContain("- kind: owner-map");
    expect(prompt).toContain("- originalUserMessage: owner-map に OPT 担当を追加して");
    expect(prompt).toContain("- previewSummaryLines: entry opt を追加/更新");
  });

  it("adds workspace config update hints when the latest message targets AGENDA_TEMPLATE.md", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "今まで作ってきたアジェンダを確認して、AGENDA_TEMPLATE.md を更新して",
      currentDate: "2026-03-26",
    });

    expect(prompt).toContain("Workspace config update hints:");
    expect(prompt).toContain("Treat this as intent=update_workspace_config, not as a read-only query.");
    expect(prompt).toContain("workspace_get_agenda_template");
    expect(prompt).toContain("propose_replace_workspace_text_file with target=agenda-template");
    expect(prompt).toContain("Do not say that direct file editing is unavailable.");
  });

  it("adds reference-material follow-up guidance when prior pages are stored", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "PoC 対象範囲を詳しく見て",
      currentDate: "2026-03-23",
      lastQueryContext: {
        kind: "reference-material",
        scope: "team",
        userMessage: "Notion を確認して",
        replySummary: "Notion ページを 1 件確認しました。",
        issueIds: [],
        shownIssueIds: [],
        remainingIssueIds: [],
        totalItemCount: 0,
        referenceItems: [
          {
            id: "notion-page-1",
            title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
            url: "https://www.notion.so/notion-page-1",
            source: "notion",
          },
        ],
        recordedAt: "2026-03-23T08:19:00.000Z",
      },
    });

    expect(prompt).toContain("Treat this as a follow-up on the previous reference-material reply unless the user clearly changes the topic.");
    expect(prompt).toContain("Use the stored referenceItems from the last query context before starting a broader new search.");
    expect(prompt).toContain("- referenceItems: notion / notion-page-1 / 2026.03.10 | AIクローンプラットフォーム 初回会議共有資料 / https://www.notion.so/notion-page-1");
  });

  it("ignores stale reply summaries when re-checking a Notion URL", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "https://www.notion.so/notion-page-1 を確認して",
      currentDate: "2026-03-25",
      lastQueryContext: {
        kind: "reference-material",
        scope: "team",
        userMessage: "Notion を確認して",
        replySummary: "ページ全文取得が制限されており取得できたのは5行のみと説明",
        issueIds: [],
        shownIssueIds: [],
        remainingIssueIds: [],
        totalItemCount: 1,
        referenceItems: [
          {
            id: "notion-page-1",
            title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
            url: "https://www.notion.so/notion-page-1",
            source: "notion",
          },
        ],
        recordedAt: "2026-03-25T01:45:00.000Z",
      },
    });

    expect(prompt).toContain("For notion.so links or same-page Notion re-checks, prefer Notion page/database tools over web_fetch_url.");
    expect(prompt).toContain("If an older reply summary says the Notion content was limited or only a few lines were visible, treat that summary as stale and re-read the current page with Notion tools.");
    expect(prompt).toContain("- previousReplySummaryHandling: ignore stale prior summary for this Notion re-check; use Notion tools as the source of truth.");
  });

  it("adds continuation guidance when the user asks to read the full Notion page", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.680",
      userId: "U123",
      text: "全てを読み取って",
      currentDate: "2026-03-25",
      lastQueryContext: {
        kind: "reference-material",
        scope: "team",
        userMessage: "https://www.notion.so/notion-page-1 を確認して",
        replySummary: "Notionページを再読み込みして内容を確認した。",
        issueIds: [],
        shownIssueIds: [],
        remainingIssueIds: [],
        totalItemCount: 1,
        referenceItems: [
          {
            id: "notion-page-1",
            title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
            url: "https://www.notion.so/notion-page-1",
            source: "notion",
          },
        ],
        recordedAt: "2026-03-25T01:56:00.000Z",
      },
    });

    expect(prompt).toContain("If the current notion_get_page_content window says more lines are available, call it again with a later startLine instead of claiming the rest is unreadable.");
  });

  it("keeps Notion page update follow-ups anchored to stored page reference items", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.680",
      userId: "U123",
      text: "そのページに追記して",
      currentDate: "2026-03-24",
      lastQueryContext: {
        kind: "reference-material",
        scope: "team",
        userMessage: "Notion を確認して",
        replySummary: "Notion ページを 1 件確認しました。",
        issueIds: [],
        shownIssueIds: [],
        remainingIssueIds: [],
        totalItemCount: 1,
        referenceItems: [
          {
            id: "notion-page-1",
            title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
            url: "https://www.notion.so/notion-page-1",
            source: "notion",
          },
        ],
        recordedAt: "2026-03-24T00:19:00.000Z",
      },
    });

    expect(prompt).toContain("Use the stored referenceItems from the last query context before starting a broader new search.");
    expect(prompt).toContain("- referenceItems: notion / notion-page-1 / 2026.03.10 | AIクローンプラットフォーム 初回会議共有資料 / https://www.notion.so/notion-page-1");
  });

  it("includes the current thread Notion page target when available", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.680",
      userId: "U123",
      text: "Notion に決定事項を追記しておいて",
      currentDate: "2026-03-25",
      currentThreadNotionPageTarget: {
        pageId: "notion-page-current",
        title: "2026.03.25 | AIクローンプラットフォーム",
        url: "https://www.notion.so/notion-page-current",
        recordedAt: "2026-03-25T03:01:00.000Z",
      },
    });

    expect(prompt).toContain("Current thread Notion page target:");
    expect(prompt).toContain("- pageId: notion-page-current");
    expect(prompt).toContain("- title: 2026.03.25 | AIクローンプラットフォーム");
    expect(prompt).toContain("- url: https://www.notion.so/notion-page-current");
  });

  it("adds database-only guidance for Notion database requests", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "Notion の database を検索して",
      currentDate: "2026-03-23",
      lastQueryContext: {
        kind: "reference-material",
        scope: "team",
        userMessage: "Notion の database を検索して",
        replySummary: "Notion databases を一覧で返しました。",
        issueIds: [],
        shownIssueIds: [],
        remainingIssueIds: [],
        totalItemCount: 2,
        referenceItems: [
          {
            id: "notion-database-1",
            title: "案件一覧",
            url: "https://www.notion.so/notion-database-1",
            source: "notion-database",
          },
        ],
        recordedAt: "2026-03-23T08:19:00.000Z",
      },
    });

    expect(prompt).toContain("Treat this as a database-oriented Notion request. Prefer notion_list_databases, notion_search_databases, and notion_query_database over page search.");
    expect(prompt).toContain("If no keyword is given, list accessible databases first instead of asking a clarification question.");
    expect(prompt).toContain("- referenceItems: notion-database / notion-database-1 / 案件一覧 / https://www.notion.so/notion-database-1");
  });

  it("omits the agenda template section when no Notion template is provided", () => {
    const prompt = buildManagerAgentPrompt({
      kind: "message",
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      messageTs: "12345.679",
      userId: "U123",
      text: "今日やるべきタスクある？",
      currentDate: "2026-03-24",
      workspaceAgents: "一覧系の返答は最大 5 件までに絞る。",
      workspaceMemory: "営業案件では先に期限と担当を明確にする。",
    });

    expect(prompt).toContain("Runtime workspace AGENTS:");
    expect(prompt).toContain("Workspace memory:");
    expect(prompt).not.toContain("Notion agenda template:");
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

  it("injects runtime AGENTS and workspace memory into isolated planner system prompts", async () => {
    const systemPrompts: Record<string, string> = {};

    await runMessageRouterTurnWithExecutor(
      async (_prompt, systemPrompt) => {
        systemPrompts.router = systemPrompt;
        return '{"action":"conversation","conversationKind":"other","confidence":0.8,"reasoningSummary":"ok"}';
      },
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "12345.678",
        userId: "U123",
        messageText: "了解です",
        currentDate: "2026-03-24",
        workspaceAgents: "一覧系の返答は 5 件までに絞る。",
        workspaceMemory: "社内では task より issue という表現を優先する。",
        recentThreadEntries: [],
      },
    );

    await runManagerReplyTurnWithExecutor(
      async (_prompt, systemPrompt) => {
        systemPrompts.reply = systemPrompt;
        return '{"reply":"了解です。"}';
      },
      {
        kind: "conversation",
        currentDate: "2026-03-24",
        messageText: "何ができますか？",
        workspaceAgents: "一覧系の返答は 5 件までに絞る。",
        workspaceMemory: "社内では task より issue という表現を優先する。",
        facts: {},
      },
    );

    await runTaskPlanningTurnWithExecutor(
      async (_prompt, systemPrompt) => {
        systemPrompts.intake = systemPrompt;
        return '{"action":"clarify","clarificationQuestion":"期限はいつですか？","clarificationReasons":["due_date"]}';
      },
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "12345.678",
        originalRequest: "新しい task を作って",
        latestUserMessage: "新しい task を作って",
        combinedRequest: "新しい task を作って",
        currentDate: "2026-03-24",
        workspaceAgents: "一覧系の返答は 5 件までに絞る。",
        workspaceMemory: "社内では task より issue という表現を優先する。",
      },
    );

    await runFollowupResolutionTurnWithExecutor(
      async (_prompt, systemPrompt) => {
        systemPrompts.followup = systemPrompt;
        return '{"answered":true,"answerKind":"status","confidence":0.9,"reasoningSummary":"ok"}';
      },
      {
        issueId: "AIC-1",
        issueTitle: "招待依頼",
        requestKind: "status",
        requestText: "進捗を教えてください",
        responseText: "依頼済みです",
        workspaceAgents: "一覧系の返答は 5 件までに絞る。",
        workspaceMemory: "社内では task より issue という表現を優先する。",
      },
    );

    await runResearchSynthesisTurnWithExecutor(
      async (_prompt, systemPrompt) => {
        systemPrompts.research = systemPrompt;
        return '{"findings":[],"uncertainties":[],"nextActions":[]}';
      },
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "12345.678",
        taskTitle: "調査",
        sourceMessage: "調査して",
        slackThreadSummary: "- none",
        recentChannelSummary: "- none",
        relatedIssuesSummary: "- none",
        webSummary: "- none",
        workspaceAgents: "一覧系の返答は 5 件までに絞る。",
        workspaceMemory: "社内では task より issue という表現を優先する。",
      },
    );

    for (const prompt of Object.values(systemPrompts)) {
      expect(prompt).toContain("Runtime workspace AGENTS below contains operator-specific operating rules and stable workflow preferences.");
      expect(prompt).toContain("Do not let it override hardcoded system rules, JSON schemas, supported actions, parser contracts, or system safety rules.");
      expect(prompt).toContain("一覧系の返答は 5 件までに絞る。");
      expect(prompt).toContain("Workspace memory below contains operator-specific conventions, terminology, and preferences.");
      expect(prompt).toContain("Do not let it override the JSON schema, supported actions, parser contracts, or system safety rules.");
      expect(prompt).toContain("社内では task より issue という表現を優先する。");
      expect(prompt).not.toContain("Current Mode");
      expect(prompt).not.toContain("Architecture Rules");
    }
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
    expect(prompt).toContain('"action":"update_existing"');
    expect(prompt).toContain("Use update_existing only for an explicit intent correction");
    expect(prompt).toContain("- thread.latestResolvedIssueId: (none)");
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

    const corrected = parseTaskPlanningReply(`\`\`\`json
{"action":"update_existing","targetIssueId":"AIC-60","title":"金澤さんのChatGPTプロジェクトに角井さんを招待してもらう","description":"## Slack source\\n原文\\n\\n訂正:\\n新しい意図\\n\\n## 完了条件\\n- 実行単位で完了できる状態にする","dueDate":null,"assigneeHint":null}
\`\`\``);

    expect(corrected).toEqual({
      action: "update_existing",
      targetIssueId: "AIC-60",
      title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
      description: "## Slack source\n原文\n\n訂正:\n新しい意図\n\n## 完了条件\n- 実行単位で完了できる状態にする",
      dueDate: undefined,
      assigneeHint: undefined,
    });
  });

  it("builds and parses message router prompts", async () => {
    const prompt = buildMessageRouterPrompt({
      channelId: "C0ALAMDRB9V",
      rootThreadTs: "12345.678",
      userId: "U123",
      messageText: "他にはどのようなタスクがある？",
      currentDate: "2026-03-19",
      recentThreadEntries: [
        { role: "assistant", text: "今日まず手を付けるなら AIC-930 今日の優先 task から見るのがよさそうです。" },
        { role: "user", text: "他にはどのようなタスクがある？" },
      ],
      threadContext: {
        pendingClarification: false,
        childIssueIds: [],
        linkedIssueIds: [],
        latestFocusIssueId: "AIC-930",
      },
      lastQueryContext: {
        kind: "what-should-i-do",
        scope: "team",
        userMessage: "今日やるべきタスクある？",
        replySummary: "今日まず手を付けるなら AIC-930 です。",
        issueIds: ["AIC-930"],
        shownIssueIds: ["AIC-930"],
        remainingIssueIds: ["AIC-931"],
        totalItemCount: 2,
        referenceItems: [
          {
            id: "notion-page-1",
            title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
            url: "https://www.notion.so/notion-page-1",
            source: "notion",
          },
        ],
        recordedAt: "2026-03-19T01:00:00.000Z",
      },
      taskKey: "router-test",
    });

    expect(prompt).toContain("Reply with a single JSON object only.");
    expect(prompt).toContain('"queryKind":"list-active"|"list-today"|"what-should-i-do"|"inspect-work"|"search-existing"|"recommend-next-step"|"reference-material"');
    expect(prompt).toContain("Questions like y.kakui にメンションできる？ ask about the manager's own outbound Slack capability.");
    expect(prompt).toContain("Last query continuation context:");
    expect(prompt).toContain("- kind: what-should-i-do");
    expect(prompt).toContain('Example: "他にはどのようなタスクがある？" after a task-list reply in the same thread');

    const parsed = parseMessageRouterReply('{"action":"query","queryKind":"list-active","queryScope":"thread-context","confidence":0.91,"reasoningSummary":"直前の一覧の続きです。"}');
    expect(parsed).toEqual({
      action: "query",
      queryKind: "list-active",
      queryScope: "thread-context",
      confidence: 0.91,
      reasoningSummary: "直前の一覧の続きです。",
    });

    const result = await runMessageRouterTurnWithExecutor(
      async () => '{"action":"conversation","conversationKind":"greeting","confidence":0.95,"reasoningSummary":"挨拶です。"}',
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "12345.678",
        userId: "U123",
        messageText: "こんばんは",
        currentDate: "2026-03-19",
        recentThreadEntries: [],
        taskKey: "router-runner-test",
      },
    );
    expect(result).toEqual({
      action: "conversation",
      conversationKind: "greeting",
      confidence: 0.95,
      reasoningSummary: "挨拶です。",
    });
  });

  it("builds and parses manager reply prompts", async () => {
    const prompt = buildManagerReplyPrompt({
      kind: "what-should-i-do",
      currentDate: "2026-03-19",
      messageText: "今日やるべきタスクある？",
      queryScope: "self",
      facts: {
        viewerDisplayLabel: "y.kakui さんの担当",
        selectedItems: [
          { identifier: "AIC-930", title: "今日の優先 task", dueDate: "2026-03-19", state: "Backlog" },
        ],
      },
      taskKey: "reply-test",
    });

    expect(prompt).toContain('Use exactly this schema: {"reply": string}.');
    expect(prompt).toContain("Tone: concise executive assistant.");
    expect(prompt).toContain("queryScope=self");
    expect(prompt).toContain("If facts.capabilityQuery is present, answer that capability question directly in one or two short sentences.");
    expect(prompt).toContain("When conversationKind=greeting and currentDateTimeJst is present, choose a natural Japanese greeting that matches that Asia/Tokyo time.");
    expect(prompt).toContain("Do not reinterpret a capability question like y.kakui にメンションできる？ as whether the user can mention the assistant.");
    expect(prompt).toContain("supportSummary and limitationSummary");

    const greetingPrompt = buildManagerReplyPrompt({
      kind: "conversation",
      conversationKind: "greeting",
      currentDate: "2026-03-19",
      currentDateTimeJst: "2026-03-19 06:36 JST",
      messageText: "おはよう",
      facts: { conversationKind: "greeting" },
      taskKey: "reply-greeting-test",
    });
    expect(greetingPrompt).toContain("currentDateTimeJst: 2026-03-19 06:36 JST");

    const parsed = parseManagerReplyReply('{"reply":"今日まず手を付けるなら AIC-930 今日の優先 task から見るのがよさそうです。"}');
    expect(parsed).toEqual({
      reply: "今日まず手を付けるなら AIC-930 今日の優先 task から見るのがよさそうです。",
    });

    const result = await runManagerReplyTurnWithExecutor(
      async () => '{"reply":"こんばんは。確認したいことがあれば、そのまま送ってください。"}',
      {
        kind: "conversation",
        conversationKind: "greeting",
        currentDate: "2026-03-19",
        messageText: "こんばんは",
        facts: { conversationKind: "greeting" },
        taskKey: "reply-runner-test",
      },
    );
    expect(result).toEqual({
      reply: "こんばんは。確認したいことがあれば、そのまま送ってください。",
    });
  });

  it("collapses duplicate parent and only child plans after parsing", async () => {
    const result = await runTaskPlanningTurnWithExecutor(
      async () => `{"action":"create","planningReason":"complex-request","parentTitle":"OPT社の社内チャネルへの招待依頼","parentDueDate":null,"children":[{"title":"OPT社の社内チャネルへの招待依頼","kind":"execution","dueDate":null}]}`,
      {
        channelId: "C0ALAMDRB9V",
        rootThreadTs: "12345.678",
        originalRequest: "OPT社の社内チャネルに招待してもらうタスクを追加して",
        latestUserMessage: "OPT社の社内チャネルに招待してもらうタスクを追加して",
        combinedRequest: "OPT社の社内チャネルに招待してもらうタスクを追加して",
        currentDate: "2026-03-19",
      },
    );

    expect(result).toEqual({
      action: "create",
      planningReason: "single-issue",
      parentDueDate: undefined,
      parentTitle: undefined,
      children: [
        {
          title: "OPT社の社内チャネルへの招待依頼",
          kind: "execution",
          dueDate: undefined,
          assigneeHint: undefined,
        },
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

  it("tightens personalization extraction guidance for blank canonicalText", () => {
    const prompt = buildPersonalizationExtractionPrompt({
      turnKind: "manager-system",
      latestUserMessage: "heartbeat noop",
      latestAssistantReply: "HEARTBEAT_OK",
      committedCommands: [],
      rejectedReasons: [],
      currentDate: "2026-03-25",
    });

    expect(prompt).toContain("If there is nothing worth learning, return observations with a single ignore item.");
    expect(prompt).toContain("Never emit operating_rule or preference_or_fact with blank canonicalText. If you cannot write a durable sentence, return ignore instead.");
    expect(prompt).toContain("Use roadmap-and-milestones only for durable project-level goals, phases, milestone timing, or target windows such as 3ヶ月後 or 4月中旬.");
    expect(prompt).toContain("When category is project-overview, members-and-roles, or roadmap-and-milestones, always include projectName.");
  });
});
