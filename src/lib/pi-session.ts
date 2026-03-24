import { writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { join } from "node:path";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import {
  runManagerReplyTurnWithExecutor,
  type ManagerReplyInput,
  type ManagerReplyResult,
} from "../planners/manager-reply/index.js";
import {
  runMessageRouterTurnWithExecutor,
  type MessageRouterInput,
  type MessageRouterResult,
} from "../planners/message-router/index.js";
import {
  runFollowupResolutionTurnWithExecutor,
  type FollowupResolutionInput,
  type FollowupResolutionResult,
} from "../planners/followup-resolution/index.js";
import {
  runResearchSynthesisTurnWithExecutor,
  type ResearchNextAction,
  type ResearchSynthesisInput,
  type ResearchSynthesisResult,
} from "../planners/research-synthesis/index.js";
import {
  runTaskPlanningTurnWithExecutor,
  type TaskPlanningInput,
  type TaskPlanningResult,
} from "../planners/task-intake/index.js";
import { createManagerAgentTools } from "./manager-agent-tools.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import { getThreadPlanningContext } from "../state/workgraph/queries.js";
import type { AppConfig } from "./config.js";
import { getLinearIssue } from "./linear.js";
import { createLinearCustomTools } from "./linear-tools.js";
import type { PendingManagerClarification } from "./pending-manager-clarification.js";
import type { ThreadQueryContinuation } from "./query-continuation.js";
import {
  extractIntentReport,
  extractManagerCommandProposals,
  extractPendingClarificationDecision,
  extractTaskExecutionDecision,
  type ManagerAgentToolCall,
  type ManagerCommandProposal,
  type ManagerIntentReport,
  type PendingClarificationDecisionReport,
  type TaskExecutionDecisionReport,
} from "./manager-command-commit.js";
import type { TaskIntent } from "./slack.js";
import { buildSystemPaths } from "./system-workspace.js";
import type { AttachmentRecord, ThreadPaths } from "./thread-workspace.js";

export interface AgentInput {
  channelId: string;
  userId: string;
  text: string;
  rootThreadTs: string;
  intent: TaskIntent;
  attachments: AttachmentRecord[];
}

export interface SystemAgentInput {
  kind: "heartbeat" | "scheduler";
  channelId: string;
  text: string;
  metadata?: Record<string, string>;
}

export interface ManagerAgentInput {
  kind: "message";
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  currentDate: string;
  lastQueryContext?: ThreadQueryContinuation;
  combinedRequestText?: string;
  pendingClarification?: PendingManagerClarification;
}

export interface ManagerSystemInput {
  kind: "heartbeat" | "scheduler" | "morning-review" | "evening-review" | "weekly-review" | "webhook-issue-created";
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  text: string;
  currentDate: string;
  runAtJst: string;
  metadata?: Record<string, string>;
}

export interface ManagerAgentTurnResult {
  reply: string;
  toolCalls: ManagerAgentToolCall[];
  proposals: ManagerCommandProposal[];
  invalidProposalCount: number;
  intentReport?: ManagerIntentReport;
  pendingClarificationDecision?: PendingClarificationDecisionReport;
  taskExecutionDecision?: TaskExecutionDecisionReport;
}

export {
  buildManagerReplyPrompt,
  parseManagerReplyReply,
  type ManagerReplyInput,
  type ManagerReplyResult,
} from "../planners/manager-reply/index.js";

export {
  buildMessageRouterPrompt,
  parseMessageRouterReply,
  type MessageRouterInput,
  type MessageRouterResult,
} from "../planners/message-router/index.js";

export {
  buildFollowupResolutionPrompt,
  parseFollowupResolutionReply,
  type FollowupResolutionInput,
  type FollowupResolutionResult,
} from "../planners/followup-resolution/index.js";

export {
  buildResearchSynthesisPrompt,
  parseResearchSynthesisReply,
  type ResearchNextAction,
  type ResearchSynthesisInput,
  type ResearchSynthesisResult,
} from "../planners/research-synthesis/index.js";

export {
  buildTaskPlanningPrompt,
  parseTaskPlanningReply,
  type TaskPlanningChild,
  type TaskPlanningInput,
  type TaskPlanningResult,
  type TaskPlanningResultClarify,
  type TaskPlanningResultCreate,
} from "../planners/task-intake/index.js";

interface SharedRuntime {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Awaited<ReturnType<ModelRegistry["getAvailable"]>>[number];
  managerRepositories: ManagerRepositories;
}

interface ThreadRuntime {
  session: AgentSession;
  lastUsedAt: number;
}

const DEFAULT_THREAD_IDLE_MS = 15 * 60 * 1000;
let sharedRuntimePromise: Promise<SharedRuntime> | undefined;
const threadRuntimePromises = new Map<string, Promise<ThreadRuntime>>();

export interface ThreadPromptCandidateIssue {
  issueId: string;
  title?: string;
}

export interface ThreadPromptContext {
  lastResolvedIssueId?: string;
  parentIssueId?: string;
  childIssueIds: string[];
  duplicateReuse: boolean;
  pendingClarification: boolean;
  preferredIssueIds: string[];
  candidateIssues: ThreadPromptCandidateIssue[];
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

async function loadThreadPromptContext(
  config: AppConfig,
  input: AgentInput,
  managerRepositories: Pick<ManagerRepositories, "workgraph">,
): Promise<ThreadPromptContext | undefined> {
  const planningContext = await getThreadPlanningContext(
    managerRepositories.workgraph,
    buildWorkgraphThreadKey(input.channelId, input.rootThreadTs),
  ).catch(() => undefined);
  if (!planningContext) {
    return undefined;
  }

  const {
    thread,
    parentIssue,
    childIssues,
    linkedIssues,
    latestResolvedIssue,
  } = planningContext;
  const childIssueIds = childIssues.map((issue) => issue.issueId);
  const linkedIssueIds = linkedIssues.map((issue) => issue.issueId);
  const candidateIds = unique([
    thread.latestFocusIssueId,
    latestResolvedIssue?.issueId,
    parentIssue?.issueId,
    ...childIssueIds,
    ...linkedIssueIds,
  ].filter(Boolean)) as string[];

  const preferredIssueIds = unique([
    ...childIssueIds,
    thread.latestFocusIssueId,
    latestResolvedIssue?.issueId,
    parentIssue?.issueId,
    ...linkedIssueIds,
    ...candidateIds,
  ].filter(Boolean)) as string[];

  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  const candidateIssues = candidateIds.length > 1
    ? (await Promise.all(
        candidateIds.slice(0, 6).map(async (issueId) => {
          try {
            const issue = await getLinearIssue(issueId, env);
            return {
              issueId,
              title: issue.title.length > 96 ? `${issue.title.slice(0, 93)}...` : issue.title,
            };
          } catch {
            return { issueId };
          }
        }),
      ))
    : [];

  return {
    lastResolvedIssueId: latestResolvedIssue?.issueId ?? thread.lastResolvedIssueId,
    parentIssueId: parentIssue?.issueId ?? thread.parentIssueId,
    childIssueIds,
    duplicateReuse: thread.intakeStatus === "linked-existing",
    pendingClarification: thread.pendingClarification,
    preferredIssueIds,
    candidateIssues,
  };
}

export function buildSystemPrompt(config: AppConfig, assistantName = "コギト"): string {
  return [
    "You are a Japanese Slack execution manager for task management.",
    `Your working name in this workspace is ${assistantName}.`,
    `If the user asks your name or how to call you, answer ${assistantName}.`,
    "Reply in Japanese.",
    "Linear is the only system of record for tracked tasks.",
    "Slack thread is the primary operator surface for day-to-day work.",
    "Do not use or invent any internal todo list.",
    "Treat the allowed Slack channel as a control room for task execution.",
    "Only use the control room for proactive reviews, urgent follow-ups, and fallback-owner notices.",
    "Use read tools to inspect Linear, workgraph, Slack context, optional Notion reference material, and lightweight web results.",
    "Use proposal tools for create/update/follow-up actions. Proposal tools do not execute side effects.",
    "Never pretend a proposal has already been committed. The manager will validate and commit proposals after your turn.",
    "When runKind=webhook-issue-created, inspect the freshly created Linear issue and decide whether immediate AI action has clear value.",
    "For webhook-issue-created system tasks, prefer no-op over speculative or low-confidence changes.",
    "Webhook issue-created processing has no Slack thread context. Use the issue facts you are given plus normal read tools, and assume the control room is the only operator surface.",
    "In normal Slack replies, describe only the result the user should observe after the manager commit. Do not mention an extra manual confirmation or approval step unless the manager explicitly rejected the action.",
    "Report your current intent with report_manager_intent once per turn before or during tool usage.",
    "When the turn is a read-only reference lookup using Notion, Slack context, docs, memos, or lightweight web material, report intent=query with queryKind=reference-material.",
    "Use intent=run_task for imperative execution requests on an existing issue such as AIC-123 を進めて, この issue を実行して, or このタスクを進めて.",
    "For run_task turns, inspect the target issue first with raw facts tools before proposing any mutation.",
    "For run_task turns, call report_task_execution_decision once with decision=execute or noop and identify the target issue whenever you can.",
    "If a run_task request has no clear immediate AI execution value, keep the reply short and use report_task_execution_decision with decision=noop.",
    "If a run_task request does have clear immediate execution value, use existing proposal tools only. Do not invent a new side-effect path.",
    "If the target issue for a run_task request is ambiguous, ask for the issue ID instead of guessing.",
    "If a run_task request is ambiguous and you ask for the issue ID, also use report_pending_clarification_decision with decision=new_request and persistence=replace so the follow-up can continue in the same thread.",
    "When the user asks about schedules, scheduler jobs, cron-style tasks, morning/evening/weekly review settings, or heartbeat settings, use the dedicated scheduler tools.",
    "Use intent=query_schedule for schedule inspection, create_schedule for custom job creation, run_schedule for immediate custom job execution, update_schedule for custom job updates or built-in disable/retime changes, and delete_schedule only for custom job deletion.",
    "Built-in schedules are morning-review, evening-review, weekly-review, and heartbeat. Manage them with propose_update_builtin_schedule instead of custom job CRUD.",
    "Treat a delete request on a built-in schedule as disable, not physical deletion.",
    "Immediate scheduler execution in this scope is supported only for custom jobs. Do not use immediate-run proposals for built-in review or heartbeat schedules.",
    "Use scheduler_list_schedules to browse current schedules and scheduler_get_schedule for one specific schedule.",
    "Use propose_create_scheduler_job, propose_update_scheduler_job, and propose_delete_scheduler_job only for custom jobs stored in jobs.json.",
    "Use propose_run_scheduler_job_now only when the user explicitly asks to run a custom job immediately for testing or one-off execution.",
    "If the user does not specify a channel for a custom scheduler job, default it to the control room channel.",
    "When creating a custom scheduler job, choose a stable explicit jobId such as daily-task-check instead of asking the manager layer to invent one.",
    "When the user asks to run a built-in schedule immediately, reply briefly that built-in immediate run is not supported in this scope instead of forcing a proposal.",
    "If a scheduler request is missing only the execution prompt, ask one concise follow-up question. Otherwise prefer immediate valid proposals.",
    "If a pending manager clarification context exists, call report_pending_clarification_decision once and include both decision and persistence.",
    "Use persistence=keep when the existing pending clarification should stay as-is, replace when this turn should create or overwrite the pending clarification state, and clear when the pending state should be removed.",
    "For query replies, call report_query_snapshot once with issueIds, shownIssueIds, remainingIssueIds, totalItemCount, replySummary, and scope.",
    "For reference-material query replies, also include referenceItems in report_query_snapshot with id, title, url, and source for each page, document, or database you surfaced.",
    "A query reply without report_query_snapshot is unsafe and will be rejected by the manager.",
    "When answering list or prioritization queries, include remainingIssueIds in report_query_snapshot whenever you can infer additional relevant issues for a follow-up like 他には？.",
    "When the last query context contains referenceItems and the user asks to look deeper into a topic, inspect those stored reference items first before running a broader new search.",
    "Prefer existing work in this order: thread-linked issue, existing parent issue, existing duplicate, then new issue.",
    "For single-issue create proposals, decide explicitly whether the issue should stay standalone or attach under the existing thread parent issue.",
    "Express that decision in propose_create_issue with threadParentHandling=attach or ignore whenever a thread parent issue exists.",
    "When search results suggest an existing duplicate, decide explicitly whether to reuse it, reattach it to the chosen parent, ask for clarification, or create a genuinely new issue.",
    "Express that duplicate decision in propose_create_issue with duplicateHandling=reuse-existing, reuse-and-attach-parent, clarify, or create-new.",
    "When the user explicitly asks to make one existing issue a child task of another existing issue, use propose_set_issue_parent instead of proposing a comment or deferring for confirmation.",
    "For every create proposal, decide explicitly whether to assign an owner now or leave the issue unassigned.",
    "Express that owner decision with assigneeMode=assign or leave-unassigned. When assigneeMode=assign, always include assignee.",
    "When a message describes a bug, UX issue, or rendering problem and ends by asking to create a task, classify it as create_work and propose a task instead of drifting into query mode.",
    "If the latest message is an intent correction like という意図です, そういう意味です, つまり, or そうではなく and a pending manager clarification context exists, report continue_pending and usually persistence=keep or replace depending on whether the pending clarification should stay unchanged or be overwritten.",
    "If the latest message asks what is happening with the pending clarification, report status_question and persistence=keep.",
    "If a pending manager clarification context exists but the latest message is a new query, new task, or new update request, report new_request and usually persistence=clear unless you intentionally replace it with a new pending clarification.",
    "Do not rely on the manager to pre-merge pending clarification text for you. If you decide continue_pending, combine the original request and the latest message yourself when reasoning.",
    "When quoted transcript or previous bot output appears inside a create request, summarize the actual problem in the title and use the transcript as supporting description only.",
    "Search before proposing new tracked work, and inspect the issue hierarchy before proposing updates.",
    "If a thread already maps to an issue, prefer that issue for progress, completion, blocked, inspect, and next-step requests.",
    "For progress, completion, and blocked signals, prefer the most specific child issue over the parent issue.",
    "When a progress, completed, or blocked update includes a new target completion date, include dueDate in propose_update_issue_status.",
    "For larger requests, propose a parent issue and execution-sized child issues.",
    "propose_create_issue_batch supports at most 8 child issues per proposal.",
    "If a request contains more than 8 child tasks, split it into multiple create_issue_batch proposals in the same turn instead of retrying after a schema failure.",
    "When research is required, save detailed findings to Linear and return only a short summary and next action to Slack.",
    "If Notion tools are available, use Notion as reference material for specs, notes, and operating context. Do not treat Notion as the task system of record.",
    "When the user explicitly asks to create an agenda in Notion, use propose_create_notion_agenda instead of creating a Linear issue.",
    "When the user explicitly asks to update, append to, retitle, archive, or delete a Notion page, use the dedicated Notion page proposal tools instead of creating or updating a Linear issue.",
    "For Notion agenda creation, use the configured default parent page unless the user clearly specifies a different Notion parent page.",
    "A minimal Notion agenda should have a short title and practical sections like 目的, 議題, 確認事項, and 次のアクション.",
    "For Notion page updates in this scope, use propose_update_notion_page with an explicit pageId, optional title, optional summary, optional sections, and appendMode=append.",
    "Notion page updates in this scope are append-only plus optional title updates. Do not propose full content replacement or arbitrary block edits.",
    "For Notion page delete requests, use propose_archive_notion_page. In this scope, delete means archive or move to trash, not permanent deletion.",
    "When the last query context contains Notion page referenceItems and the user says そのページを更新して, このページに追記して, そのページを削除して, or そのページをアーカイブして, use that stored page as the target and make the pageId explicit in the proposal.",
    "Do not apply Notion page update or archive proposals to notion-database reference items. Database row mutation is out of scope.",
    "For reference-material replies that mention multiple Notion pages, documents, or databases, use short bullet lines and include markdown links when URLs are available.",
    "When notion_get_page_content succeeds, summarize the relevant excerpt or page lines instead of saying the content is unavailable.",
    "If the user explicitly says database or データベース, treat it as a database-only request unless they also ask for pages.",
    "A request like Notion の database を検索して is still a query. Do not downgrade it to casual conversation just because the keyword is missing.",
    "If the user asks to browse or search Notion databases without a keyword, use notion_list_databases before asking a follow-up question.",
    "When the relevant Notion information is structured in a database, prefer notion_search_databases and notion_query_database over broad page summarization.",
    "When you surface a Notion database in report_query_snapshot, set the referenceItems source to notion-database.",
    "If the last query context contains a notion-database reference item and the user says その database を見て or その一覧を確認して, query that database before starting a broader new search.",
    "Before filtering or sorting a Notion database, call notion_get_database_facts so you know the property names, types, and status/select options.",
    "Use notion_query_database filterProperty/filterOperator/filterValue when the user narrows a Notion database like 進行中だけ, 自分の担当だけ, or 期限が今週のもの.",
    "Use notion_query_database sortProperty/sortDirection when the user asks for an order like 期限が近い順 or 更新が新しい順.",
    "For reviews and heartbeat-style summaries, prefer one concrete follow-up request over broad list-making.",
    "For scheduled review or heartbeat replies, never use markdown tables, pipe tables, separator lines, or report-style section headings.",
    "For review and heartbeat reasoning, treat any issue with isOpen=false or completedAt set as completed. Do not describe it as currently in progress or currently risky.",
    "If completed child issues matter, mention them only as a brief improvement note. Keep the current action list focused on open issues.",
    "When review facts include dueRelativeLabel or daysUntilDue, use that relative due wording verbatim instead of inferring your own 明日, 今日, or 3日後 wording from dueDate.",
    "For scheduled review or heartbeat replies, use only one short opening sentence and do not repeat the same improvement summary in both the opening and the body.",
    "For schedule-list replies, use short bullets with schedule ids and timing. Do not use markdown tables or wrap schedule ids in backticks.",
    "When describing schedule status to the user, mention lastRunAt, lastStatus, lastResult, or lastError when they materially help answer what happened most recently.",
    "When the user says 毎日 9:00, 毎週火曜, or 30分ごと, convert that into a valid scheduler proposal instead of asking the manager layer to parse it later.",
    "Treat 〜を今すぐ実行して, 〜のテスト実行をして, and 〜を試しに一度動かして as scheduler immediate-run requests for custom jobs.",
    "When the user asks to stop, resume, or retime morning/evening/weekly review or heartbeat, update the built-in schedule directly through propose_update_builtin_schedule.",
    "Use raw facts tools for priority and review judgments. Do not rely on the manager commit layer to choose owners, attach parents, or pick duplicates for you.",
    "If the request is ambiguous, ask exactly one concise follow-up question instead of proposing a mutation.",
    "Do not ask the user for API keys, workspace identifiers, or team identifiers. They are fixed in the environment.",
    "Do not mutate internal state directly. Only the manager commit layer may update Linear, workgraph, planning, or follow-up ledgers.",
    `The fixed Linear workspace slug is ${config.linearWorkspace}.`,
    `The fixed Linear team key is ${config.linearTeamKey}.`,
    "Interpret relative dates in Asia/Tokyo and convert them to YYYY-MM-DD before passing due dates to Linear.",
    "If the user says 今週中 or 今週を目処 without a specific date, resolve it to the Friday of the current JST work week unless the user says otherwise.",
    "Keep public Slack replies short and natural. Do not expose tool logs or raw output unless the user asks.",
    "For public Slack replies, default to 1-3 short sentences.",
    "Do not use markdown headings, separator lines, report-style sections, warning icons, or emojis in public Slack replies.",
    "For a single important issue, answer directly in one sentence before adding any supporting detail.",
    "Only use bullets when naming multiple issues, and keep that list to at most 3 short bullets unless the user explicitly asks for a full list.",
    "If the user says things like 他には / ほかには / 他のタスク after a list or prioritization reply in the same thread, continue that list naturally instead of reframing the answer as an inspect-work reply.",
    "Avoid date-heavy opening phrases like 今日（3/23）時点で unless the user explicitly asks for a dated summary.",
    "Use issue identifiers, due dates, owners, and thread context facts in replies when they materially help the user.",
  ].join("\n");
}

function currentDateInJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sanitizeSessionSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "default";
}

export function buildAgentPrompt(
  input: AgentInput,
  config: AppConfig,
  paths: ThreadPaths,
  context?: ThreadPromptContext,
): string {
  const attachmentLines =
    input.attachments.length > 0
      ? input.attachments
          .map((attachment) => `- ${attachment.name}: ${relative(paths.rootDir, attachment.storedPath)}`)
          .join("\n")
      : "- none";

  const threadContextLines = context
    ? [
        `- lastResolvedIssueId: ${context.lastResolvedIssueId ?? "none"}`,
        `- parentIssueId: ${context.parentIssueId ?? "none"}`,
        `- childIssueIds: ${context.childIssueIds.length > 0 ? context.childIssueIds.join(", ") : "none"}`,
        `- duplicateReuse: ${context.duplicateReuse ? "yes" : "no"}`,
        `- pendingClarification: ${context.pendingClarification ? "yes" : "no"}`,
        `- preferredIssueIds: ${context.preferredIssueIds.length > 0 ? context.preferredIssueIds.join(", ") : "none"}`,
      ]
    : ["- none"];

  const candidateIssueLines = context && context.candidateIssues.length > 0
    ? context.candidateIssues.map((issue) => `- ${issue.issueId}${issue.title ? ` / ${issue.title}` : ""}`)
    : ["- none"];

  return [
    "Slack message metadata:",
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- userId: ${input.userId}`,
    `- intentHint: ${input.intent}`,
    `- fixedLinearWorkspace: ${config.linearWorkspace}`,
    `- fixedLinearTeamKey: ${config.linearTeamKey}`,
    `- currentDateJst: ${currentDateInJst()}`,
    "",
    "Attachments:",
    attachmentLines,
    "",
    "Thread-linked issue context:",
    ...threadContextLines,
    "",
    "Candidate issue summaries:",
    ...candidateIssueLines,
    "",
    "Current user message:",
    input.text || "(no text, attachments only)",
  ].join("\n");
}

function buildSystemPromptInput(input: SystemAgentInput, config: AppConfig): string {
  const metadataLines = Object.entries(input.metadata ?? {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");

  return [
    "System automation context:",
    `- runKind: ${input.kind}`,
    `- channelId: ${input.channelId}`,
    `- fixedLinearWorkspace: ${config.linearWorkspace}`,
    `- fixedLinearTeamKey: ${config.linearTeamKey}`,
    `- currentDateJst: ${currentDateInJst()}`,
    ...(metadataLines ? ["", "Metadata:", metadataLines] : []),
    "",
    "Task:",
    input.text,
  ].join("\n");
}

function extractAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;

    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
            return String(item.text);
          }
          return "";
        })
        .join("")
        .trim();
    }
  }

  return "";
}

async function runIsolatedPromptTurn(
  config: AppConfig,
  paths: ThreadPaths,
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
): Promise<string> {
  const shared = await getSharedRuntime(config);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 1 },
  });

  const loader = new DefaultResourceLoader({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const sessionFile = join(paths.scratchDir, `isolated-${sanitizeSessionSuffix(sessionSuffix)}.jsonl`);
  const sessionManager = SessionManager.open(sessionFile, paths.rootDir);
  const { session } = await createAgentSession({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    model: shared.model,
    thinkingLevel: "minimal",
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    customTools: [],
  });

  const deltas: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(prompt);
    await session.agent.waitForIdle();
    const text = deltas.join("").trim() || extractAssistantText(session.messages as unknown[]);
    if (!text) {
      throw new Error("Agent finished without producing a research synthesis reply");
    }
    return text;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

function buildThreadRuntimeKey(paths: ThreadPaths): string {
  return paths.sessionFile;
}

async function getSharedRuntime(config: AppConfig): Promise<SharedRuntime> {
  if (!sharedRuntimePromise) {
    sharedRuntimePromise = (async () => {
      const agentDir = join(config.workspaceDir, ".pi", "agent");
      const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
      if (config.anthropicApiKey) {
        authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
      }

      const modelRegistry = new ModelRegistry(authStorage);
      const requestedModel = modelRegistry.find("anthropic", config.botModel);
      const availableModels = await modelRegistry.getAvailable();
      const fallbackModel = availableModels.find((model) => model.provider === "anthropic");
      const model = requestedModel ?? fallbackModel;

      if (!model) {
        throw new Error(`Unable to resolve bot model "${config.botModel}" for Anthropic`);
      }

      return {
        agentDir,
        authStorage,
        modelRegistry,
        model,
        managerRepositories: createFileBackedManagerRepositories(buildSystemPaths(config.workspaceDir)),
      };
    })().catch((error) => {
      sharedRuntimePromise = undefined;
      throw error;
    });
  }

  return sharedRuntimePromise;
}

async function createThreadRuntime(config: AppConfig, paths: ThreadPaths): Promise<ThreadRuntime> {
  const shared = await getSharedRuntime(config);
  const managerPolicy = await shared.managerRepositories.policy.load();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 1 },
  });

  const loader = new DefaultResourceLoader({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => buildSystemPrompt(config, managerPolicy.assistantName),
  });
  await loader.reload();

  const sessionManager = SessionManager.open(paths.sessionFile, paths.rootDir);
  const { session } = await createAgentSession({
    cwd: paths.rootDir,
    agentDir: shared.agentDir,
    model: shared.model,
    thinkingLevel: "minimal",
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    customTools: createManagerAgentTools(config, shared.managerRepositories),
  });

  return {
    session,
    lastUsedAt: Date.now(),
  };
}

async function getOrCreateThreadRuntime(config: AppConfig, paths: ThreadPaths): Promise<ThreadRuntime> {
  const key = buildThreadRuntimeKey(paths);
  const existing = threadRuntimePromises.get(key);

  if (existing) {
    const runtime = await existing;
    runtime.lastUsedAt = Date.now();
    return runtime;
  }

  const pending = createThreadRuntime(config, paths).catch((error) => {
    threadRuntimePromises.delete(key);
    throw error;
  });
  threadRuntimePromises.set(key, pending);

  const runtime = await pending;
  runtime.lastUsedAt = Date.now();
  return runtime;
}

async function disposeThreadRuntime(key: string): Promise<void> {
  const pending = threadRuntimePromises.get(key);
  if (!pending) return;

  threadRuntimePromises.delete(key);
  try {
    const runtime = await pending;
    runtime.session.dispose();
  } catch {
    // Ignore startup failures while cleaning up stale runtime entries.
  }
}

export async function disposeIdleThreadRuntimes(maxIdleMs = DEFAULT_THREAD_IDLE_MS): Promise<void> {
  const now = Date.now();
  const staleKeys: string[] = [];

  for (const [key, pending] of threadRuntimePromises.entries()) {
    try {
      const runtime = await pending;
      if (now - runtime.lastUsedAt >= maxIdleMs) {
        staleKeys.push(key);
      }
    } catch {
      staleKeys.push(key);
    }
  }

  await Promise.all(staleKeys.map((key) => disposeThreadRuntime(key)));
}

export async function disposeAllThreadRuntimes(): Promise<void> {
  await Promise.all(Array.from(threadRuntimePromises.keys()).map((key) => disposeThreadRuntime(key)));
}

export async function runAgentTurn(config: AppConfig, paths: ThreadPaths, input: AgentInput): Promise<string> {
  const shared = await getSharedRuntime(config);
  const context = await loadThreadPromptContext(config, input, shared.managerRepositories);
  return runPromptTurn(config, paths, buildAgentPrompt(input, config, paths, context));
}

export async function runSystemTurn(config: AppConfig, paths: ThreadPaths, input: SystemAgentInput): Promise<string> {
  return runPromptTurn(config, paths, buildSystemPromptInput(input, config));
}

function buildManagerReplyStyleHints(
  messageText: string,
  lastQueryContext?: ThreadQueryContinuation,
  pendingClarification?: PendingManagerClarification,
): string[] {
  const normalized = messageText.trim();
  const hints = [
    "Keep the public Slack reply to 1-3 short sentences by default.",
    "Do not use markdown headings, separator lines, warning icons, or emojis.",
    "Do not turn a short answer into a report.",
    "If you need a list, use at most 3 short bullets and only after the main conclusion sentence.",
  ];

  if (/(他には|ほかには|他のタスク|ほかのタスク)/.test(normalized)) {
    hints.push("Treat this as a continuation of the previous list or prioritization reply in the same thread, not as a narrow inspect-work request.");
    hints.push("If there is only one additional relevant issue or no additional issue, say that plainly in one sentence.");
    if (lastQueryContext) {
      hints.push(`Continue from the stored last query context (${lastQueryContext.kind} / ${lastQueryContext.scope}) unless the latest message clearly changes the topic.`);
    }
  }

  if (/(今日やるべき|何から|優先順位)/.test(normalized)) {
    hints.push("Answer the top recommendation first in one sentence. Add only one short supporting sentence unless the user asks for more detail.");
  }

  if (/(タスク一覧|一覧|どのようなタスク|どんなタスク)/.test(normalized)) {
    hints.push("For task-list replies, prefer a plain conversational sentence before any bullets.");
  }

  if (lastQueryContext?.kind === "reference-material" && /(?:詳しく|詳細|項目|内容|範囲|確認|見て|読んで|教えて|更新|追記|アーカイブ|削除)/.test(normalized)) {
    hints.push("Treat this as a follow-up on the previous reference-material reply unless the user clearly changes the topic.");
    hints.push("Use the stored referenceItems from the last query context before starting a broader new search.");
  }

  if (/(?:notion|ノーション).*(?:database|データベース)|(?:database|データベース).*(?:notion|ノーション)/i.test(normalized)) {
    hints.push("Treat this as a database-oriented Notion request. Prefer notion_list_databases, notion_search_databases, and notion_query_database over page search.");
    if (
      !/(?:その|この).*(?:database|データベース)|一覧を(?:見て|確認)/.test(normalized)
      && !/「.+」|\".+\"|'.+'/.test(normalized)
      && !/(?:案件一覧|一覧|検索語|キーワード)/.test(normalized)
    ) {
      hints.push("If no keyword is given, list accessible databases first instead of asking a clarification question.");
    }
  }

  if (pendingClarification?.intent === "create_work") {
    hints.push("If the latest message looks like a clarification or intent correction, treat it as a continuation of the pending create request, not as a new topic.");
  }

  return hints;
}

export function buildManagerAgentPrompt(input: ManagerAgentInput): string {
  const styleHints = buildManagerReplyStyleHints(input.text, input.lastQueryContext, input.pendingClarification)
    .map((hint) => `- ${hint}`);
  const lastQueryContextLines = input.lastQueryContext
    ? [
        `- kind: ${input.lastQueryContext.kind}`,
        `- scope: ${input.lastQueryContext.scope}`,
        `- issueIds: ${input.lastQueryContext.issueIds.join(", ") || "(none)"}`,
        `- shownIssueIds: ${input.lastQueryContext.shownIssueIds.join(", ") || "(none)"}`,
        `- remainingIssueIds: ${input.lastQueryContext.remainingIssueIds.join(", ") || "(none)"}`,
        `- totalItemCount: ${input.lastQueryContext.totalItemCount}`,
        `- referenceItems: ${input.lastQueryContext.referenceItems?.length
          ? input.lastQueryContext.referenceItems
            .map((item) => [item.source, item.id, item.title, item.url].filter(Boolean).join(" / "))
            .join(" | ")
          : "(none)"}`,
        `- previousUserMessage: ${input.lastQueryContext.userMessage || "(none)"}`,
        `- previousReplySummary: ${input.lastQueryContext.replySummary || "(none)"}`,
        `- recordedAt: ${input.lastQueryContext.recordedAt}`,
      ]
    : ["- (none)"];
  const pendingClarificationLines = input.pendingClarification
    ? [
        `- intent: ${input.pendingClarification.intent}`,
        `- originalUserMessage: ${input.pendingClarification.originalUserMessage}`,
        `- lastUserMessage: ${input.pendingClarification.lastUserMessage}`,
        `- clarificationReply: ${input.pendingClarification.clarificationReply}`,
        `- missingDecisionSummary: ${input.pendingClarification.missingDecisionSummary ?? "(none)"}`,
        `- threadParentIssueId: ${input.pendingClarification.threadParentIssueId ?? "(none)"}`,
        `- relatedIssueIds: ${input.pendingClarification.relatedIssueIds.join(", ") || "(none)"}`,
        `- recordedAt: ${input.pendingClarification.recordedAt}`,
      ]
    : ["- (none)"];
  return [
    "Manager message context:",
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- sourceMessageTs: ${input.messageTs}`,
    `- userId: ${input.userId}`,
    `- currentDateJst: ${input.currentDate}`,
    "",
    "User message:",
    input.text || "(empty)",
    "",
    "Last query continuation context:",
    ...lastQueryContextLines,
    "",
    "Pending manager clarification context:",
    ...pendingClarificationLines,
    "",
    "Public reply style hints:",
    ...styleHints,
  ].join("\n");
}

export function buildManagerSystemPromptInput(input: ManagerSystemInput): string {
  const metadataLines = Object.entries(input.metadata ?? {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");

  return [
    "Manager system task context:",
    `- runKind: ${input.kind}`,
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- sourceMessageTs: ${input.messageTs}`,
    `- currentDateJst: ${input.currentDate}`,
    `- runAtJst: ${input.runAtJst}`,
    ...(metadataLines ? ["", "Metadata:", metadataLines] : []),
    "",
    "Task:",
    input.text,
  ].join("\n");
}

export async function runResearchSynthesisTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ResearchSynthesisInput,
): Promise<ResearchSynthesisResult> {
  return runResearchSynthesisTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
}

export async function runMessageRouterTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: MessageRouterInput,
): Promise<MessageRouterResult> {
  return runMessageRouterTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
}

export async function runManagerReplyTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerReplyInput,
): Promise<ManagerReplyResult> {
  return runManagerReplyTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
}

export async function runTaskPlanningTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: TaskPlanningInput,
): Promise<TaskPlanningResult> {
  return runTaskPlanningTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
}

export async function runFollowupResolutionTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: FollowupResolutionInput,
): Promise<FollowupResolutionResult> {
  return runFollowupResolutionTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    input,
  );
}

async function runStructuredPromptTurn(
  config: AppConfig,
  paths: ThreadPaths,
  prompt: string,
): Promise<ManagerAgentTurnResult> {
  const runtimeKey = buildThreadRuntimeKey(paths);
  const runtime = await getOrCreateThreadRuntime(config, paths);
  const messageCountBefore = runtime.session.messages.length;
  const deltas: string[] = [];
  const toolCalls: ManagerAgentToolCall[] = [];

  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
      return;
    }

    if (event.type === "tool_execution_end") {
      const result = event.result as { details?: unknown } | undefined;
      toolCalls.push({
        toolName: event.toolName,
        details: result?.details,
        isError: event.isError,
      });
    }
  });

  try {
    await runtime.session.prompt(prompt);
    await runtime.session.agent.waitForIdle();

    const newMessages = (runtime.session.messages as unknown[]).slice(messageCountBefore);
    const reply = deltas.join("").trim() || extractAssistantText(newMessages);
    if (!reply) {
      throw new Error("Agent finished without producing a reply");
    }

    runtime.lastUsedAt = Date.now();

    const lastReplyPath = join(paths.scratchDir, "last-reply.txt");
    await writeFile(lastReplyPath, `${reply}\n`, "utf8");

    const { proposals, invalidProposalCount } = extractManagerCommandProposals(toolCalls);
    return {
      reply,
      toolCalls,
      proposals,
      invalidProposalCount,
      intentReport: extractIntentReport(toolCalls),
      pendingClarificationDecision: extractPendingClarificationDecision(toolCalls),
      taskExecutionDecision: extractTaskExecutionDecision(toolCalls),
    };
  } catch (error) {
    await disposeThreadRuntime(runtimeKey);
    throw error;
  } finally {
    unsubscribe();
    runtime.lastUsedAt = Date.now();
  }
}

export async function runManagerAgentTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerAgentInput,
): Promise<ManagerAgentTurnResult> {
  return runStructuredPromptTurn(config, paths, buildManagerAgentPrompt(input));
}

export async function runManagerSystemTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerSystemInput,
): Promise<ManagerAgentTurnResult> {
  return runStructuredPromptTurn(config, paths, buildManagerSystemPromptInput(input));
}

async function runPromptTurn(config: AppConfig, paths: ThreadPaths, prompt: string): Promise<string> {
  const runtimeKey = buildThreadRuntimeKey(paths);
  const runtime = await getOrCreateThreadRuntime(config, paths);
  const messageCountBefore = runtime.session.messages.length;
  const deltas: string[] = [];
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });

  try {
    await runtime.session.prompt(prompt);
    await runtime.session.agent.waitForIdle();

    const newMessages = (runtime.session.messages as unknown[]).slice(messageCountBefore);
    const text = deltas.join("").trim() || extractAssistantText(newMessages);
    if (!text) {
      throw new Error("Agent finished without producing a reply");
    }

    runtime.lastUsedAt = Date.now();

    const lastReplyPath = join(paths.scratchDir, "last-reply.txt");
    await writeFile(lastReplyPath, `${text}\n`, "utf8");
    return text;
  } catch (error) {
    await disposeThreadRuntime(runtimeKey);
    throw error;
  } finally {
    unsubscribe();
    runtime.lastUsedAt = Date.now();
  }
}
