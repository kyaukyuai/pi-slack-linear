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
import {
  runPersonalizationExtractionTurnWithExecutor,
  type PersonalizationExtractionInput,
  type PersonalizationExtractionResult,
} from "../planners/personalization-extraction/index.js";
import {
  buildSlackGreetingPromptHints,
  detectSlackCapabilityQuery,
  detectSlackOutboundPostRequest,
} from "../orchestrators/shared/slack-conversation.js";
import {
  WEBHOOK_INITIAL_PROPOSAL_HEADING,
  WEBHOOK_INITIAL_PROPOSAL_MARKER,
} from "../orchestrators/webhooks/initial-proposal-comment.js";
import { selectFinalAssistantText } from "../runtime/assistant-text.js";
import { findAssistantLlmFailure, LlmProviderFailureError } from "./llm-failure.js";
import { createManagerAgentTools } from "./manager-agent-tools.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import { getThreadPlanningContext } from "../state/workgraph/queries.js";
import type { AppConfig } from "./config.js";
import { getLinearIssue } from "./linear.js";
import { createLinearCustomTools } from "./linear-tools.js";
import type { PendingManagerClarification } from "./pending-manager-clarification.js";
import type { PendingManagerConfirmation } from "./pending-manager-confirmation.js";
import type { ThreadQueryContinuation } from "./query-continuation.js";
import type { ThreadNotionPageTarget } from "./thread-notion-page-target.js";
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
import { buildSystemPaths, loadWorkspaceCustomization, type WorkspaceCustomizationContext } from "./system-workspace.js";
import type { AttachmentRecord, ThreadPaths } from "./thread-workspace.js";
import {
  createLlmSettingsManager,
  resolveLlmRuntimeDependencies,
  type LlmRuntimeConfig,
  wrapStreamFnWithMaxOutputTokens,
} from "../runtime/llm-runtime-config.js";

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
  currentDateTimeJst?: string;
  lastQueryContext?: ThreadQueryContinuation;
  currentThreadNotionPageTarget?: ThreadNotionPageTarget;
  combinedRequestText?: string;
  pendingClarification?: PendingManagerClarification;
  pendingConfirmation?: PendingManagerConfirmation;
  workspaceAgents?: string;
  workspaceMemory?: string;
  agendaTemplate?: string;
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
  workspaceAgents?: string;
  workspaceMemory?: string;
  agendaTemplate?: string;
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

function hasExplicitNotionUrl(text: string | undefined): boolean {
  return /https?:\/\/www\.notion\.so\/\S+/i.test(text ?? "");
}

function hasStoredNotionPageReference(lastQueryContext?: ThreadQueryContinuation): boolean {
  return lastQueryContext?.referenceItems?.some((item) => item.source === "notion") ?? false;
}

function shouldTreatAsNotionRecheck(messageText: string, lastQueryContext?: ThreadQueryContinuation): boolean {
  if (hasExplicitNotionUrl(messageText)) {
    return true;
  }
  if (lastQueryContext?.kind !== "reference-material" || !hasStoredNotionPageReference(lastQueryContext)) {
    return false;
  }
  return /(?:詳しく|詳細|項目|内容|範囲|確認|見て|読んで|教えて|保存|メモリ|memory|全て|全文|全体|最後まで|残りも|全部)/i.test(messageText);
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

export {
  buildPersonalizationExtractionPrompt,
  parsePersonalizationExtractionReply,
  type PersonalizationExtractionInput,
  type PersonalizationExtractionResult,
  type PersonalizationObservation,
} from "../planners/personalization-extraction/index.js";

interface SharedRuntime {
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: Awaited<ReturnType<ModelRegistry["getAvailable"]>>[number];
  llmRuntimeConfig: LlmRuntimeConfig;
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
    "If runtime workspace AGENTS are provided in the prompt context, treat them as operator-specific operating rules and stable workflow preferences unless they conflict with hardcoded system rules.",
    "If workspace memory is provided in the prompt context, treat it as operator-specific terminology, project knowledge, durable context, and preferences unless it conflicts with the system rules.",
    "If a Notion agenda template is provided in the prompt context, prefer it when creating or extending Notion agendas unless the user explicitly overrides it.",
    "Use proposal tools for create/update/follow-up actions. Proposal tools do not execute side effects.",
    "Never pretend a proposal has already been committed. The manager will validate and commit proposals after your turn.",
    "When runKind=webhook-issue-created, default to a best-effort initial proposal comment on the created issue instead of no-op.",
    "For webhook-issue-created system tasks, first call linear_get_issue_facts for the created issue to inspect raw facts and existing comments before you decide.",
    "Webhook issue-created processing has no Slack thread context. Use the issue facts you are given plus normal read tools, assume the control room is the only operator surface, and do not ask follow-up questions in webhook mode.",
    "For webhook-issue-created system tasks, the only allowed mutation proposal is propose_add_comment for the created issue itself. Do not propose status changes, assignee changes, relations, child issues, or any other side effects.",
    `For webhook-issue-created system tasks, if issue facts already show a comment containing the exact marker ${WEBHOOK_INITIAL_PROPOSAL_MARKER}, use report_task_execution_decision with decision=noop and do not propose another comment.`,
    `For webhook-issue-created system tasks, when you propose the initial comment body, start it with the exact marker ${WEBHOOK_INITIAL_PROPOSAL_MARKER} on its own line, then ${WEBHOOK_INITIAL_PROPOSAL_HEADING} on its own line.`,
    "For webhook-issue-created system tasks, write the comment in Japanese and keep it best-effort even when the issue is underspecified.",
    "For webhook-issue-created system tasks, include at least one concrete next step, one implementation or investigation suggestion, and one risk, tradeoff, or confirmation point in the comment.",
    "For webhook-issue-created system tasks, for research or design issues propose an approach, alternatives, decision criteria, and the next step.",
    "For webhook-issue-created system tasks, for execution or implementation issues propose a first approach, a practical breakdown, key risks, and what to verify next.",
    "For webhook-issue-created system tasks, for thin issues do not stop at generalities. State hypotheses, the first thing to confirm, and a provisional path forward.",
    "For webhook-issue-created system tasks, use report_task_execution_decision once with decision=execute when you propose a comment, and use noop only for duplicate-marker or technical inability.",
    "In normal Slack replies, describe only the result the user should observe after the manager commit, and never say 提案しました, 準備ができました, or 送る準備ができました for work that commits in the same turn. The one exception is owner-map updates, which may go through a manager-owned preview-and-confirm step before commit.",
    "Report your current intent with report_manager_intent once per turn before or during tool usage.",
    "When intent=conversation, include conversationKind=greeting | smalltalk | other in report_manager_intent.",
    "When the turn is a read-only reference lookup using Notion, Slack context, docs, memos, or lightweight web material, report intent=query with queryKind=reference-material.",
    "Use intent=run_task for imperative execution requests on an existing issue such as AIC-123 を進めて, この issue を実行して, or このタスクを進めて.",
    "For run_task turns, inspect the target issue first with raw facts tools before proposing any mutation.",
    "For run_task turns, call report_task_execution_decision once with decision=execute or noop and identify the target issue whenever you can.",
    "Do not downgrade an explicit imperative issue execution request such as AIC-123 を実行して or AIC-123 を進めて into intent=query just because you want to inspect the issue first; keep it as run_task and then decide execute or noop.",
    "If a run_task request has no clear executable manager action, keep the reply short, explain why no executable manager action exists now, and use report_task_execution_decision with decision=noop.",
    "If a run_task request does have a clear executable manager action, use existing proposal tools only. Do not invent a new side-effect path.",
    "For run_task replies, say in one or two short sentences why you executed or no-oped, what concrete action you took or skipped, and where the user should look next.",
    "For run_task execute replies, name the concrete action such as a status update, comment, Notion update, or scheduler change instead of saying only 実行しました.",
    "For run_task noop replies, avoid vague value-based wording like 実行価値. State the practical reason and, when helpful, one short next step.",
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
    "For Linear issue delete or cancel requests, use propose_update_issue_status with signal=completed and state=Canceled.",
    "Do not use Cancelled for Linear issue state updates; use the exact state name Canceled.",
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
    "When the user explicitly asks to save durable knowledge into MEMORY or workspace memory, use propose_update_workspace_memory as the primary path instead of relying only on silent personalization.",
    "When the user explicitly asks to update, replace, rewrite, edit, or reflect changes into AGENDA_TEMPLATE.md, use intent=update_workspace_config, read the current file with workspace_get_agenda_template first, and then use propose_replace_workspace_text_file with target=agenda-template.",
    "When the user explicitly asks to update, replace, rewrite, edit, or reflect changes into HEARTBEAT.md, use intent=update_workspace_config, read the current file with workspace_get_heartbeat_prompt first, and then use propose_replace_workspace_text_file with target=heartbeat-prompt.",
    "When the user explicitly asks to update, change, edit, add to, or delete from owner-map.json, use intent=update_workspace_config, read the current file with workspace_get_owner_map first, and then use propose_update_owner_map with a structured operation instead of free-form JSON edits.",
    "When the user explicitly asks to mention someone and send a Slack message, use intent=post_slack_message instead of treating it as a capability query or a generic conversation.",
    "Before proposing a Slack mention post, call workspace_get_owner_map and resolve exactly one target by exact-match on entry.id, linearAssignee, or slackUserId after trim, lowercase, and whitespace normalization.",
    "If owner-map resolution returns zero or multiple matches, ask one short clarification question instead of proposing a mutation.",
    "For explicit Slack mention posts, default destination=current-thread unless the user explicitly says control room. control-room-root posts go to the control room root message, not a new thread.",
    "Use propose_post_slack_message for exactly one target and one post. messageText must be the final body without the target mention token, and it must not contain extra user, group, or channel mention tokens.",
    "Do not route AGENDA_TEMPLATE.md, HEARTBEAT.md, or owner-map.json changes through MEMORY saves or silent personalization.",
    "owner-map updates use a preview-first path in this scope. The first turn may return a confirmation preview instead of an immediate commit.",
    "Never reply that direct file editing tools are unavailable for AGENDA_TEMPLATE.md, HEARTBEAT.md, or owner-map.json. Use the dedicated workspace config read and proposal tools in this runtime.",
    "For explicit MEMORY saves, it is valid to save a structured project snapshot with several entries such as project-overview, members-and-roles, roadmap-and-milestones, terminology, and context.",
    "For Notion-based MEMORY save requests, call notion_get_page_content first and extract durable project facts, members, roadmap milestones, terminology, preferences, or context from the page content.",
    "When the user asks to read an entire Notion page or save its overall content into MEMORY, continue calling notion_get_page_content with later startLine values if the current window says more lines are available.",
    "Do not copy an entire document into MEMORY. Save only stable facts that should persist across future turns.",
    "For MEMORY, roadmap-and-milestones is only for project-level goals, phases, milestone windows, or durable schedule targets. Never store issue-level due dates, current status, current assignee, or today-only plans in roadmap-and-milestones.",
    "For project-overview, members-and-roles, and roadmap-and-milestones memory entries, always include the project name explicitly.",
    "For Notion agenda creation, use the configured default parent page unless the user clearly specifies a different Notion parent page.",
    "A minimal Notion agenda should have a short title and practical sections like 目的, 議題, 確認事項, and 次のアクション.",
    "For Notion page updates in this scope, use propose_update_notion_page with an explicit pageId and mode=append or mode=replace_section.",
    "Use mode=append for requests like 追記して, 補足を足して, or メモを追加して.",
    "Use mode=replace_section for requests like 「議題」を更新して or 「次のアクション」を置き換えて. In replace_section, include sectionHeading and replacement paragraph or bullets.",
    "replace_section is allowed only for Cogito-managed Notion pages. Do not propose replace_section for arbitrary or unregistered pages.",
    "Do not propose full content replacement or arbitrary block edits for Notion pages in this scope.",
    "If the requested Notion section heading may not exist, prefer a rejectable replace_section proposal with the explicit heading instead of silently appending or creating a new heading.",
    "For Notion page delete requests, use propose_archive_notion_page. In this scope, delete means archive or move to trash, not permanent deletion.",
    "When the last query context contains Notion page referenceItems and the user says そのページを更新して, このページに追記して, そのページを削除して, or そのページをアーカイブして, use that stored page as the target and make the pageId explicit in the proposal.",
    "When the thread has a current active Notion page target and the user asks for a generic Notion follow-up like Notion に追記して, 決定事項を反映して, そのページを更新して, or そのページを削除して without a different explicit page reference, use that current thread page as the default target.",
    "If the thread has a current active Notion page target, prefer it over stale historical page IDs from the same thread unless the user explicitly points to another page.",
    "Do not apply Notion page update or archive proposals to notion-database reference items. Database row mutation is out of scope.",
    "For reference-material replies that mention multiple Notion pages, documents, or databases, use short bullet lines and include markdown links when URLs are available.",
    "When notion_get_page_content succeeds, summarize the relevant excerpt or page lines instead of saying the content is unavailable.",
    "notion_get_page_content returns a display window over the extracted page lines, not a hard retrieval limit. If the tool says more lines are available, call it again with a later startLine when you need broader coverage.",
    "Do not use web_fetch_url as the primary read path for notion.so links when Notion tools are available. Prefer Notion page or database tools first.",
    "If the user re-checks a Notion page or sends the same notion.so URL again, ignore stale earlier summaries about truncated content and re-read it with Notion tools.",
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
    "Treat review / heartbeat / webhook summaries as system notifications, not as arbitrary outbound Slack message sends.",
    "For review / heartbeat / webhook summaries, never mention a person in the summary or issue bullets.",
    "Only when issuing one explicit follow-up request may you mention at most one target once at the start of that follow-up request.",
    "For review and heartbeat reasoning, treat any issue with isOpen=false or completedAt set as completed. Do not describe it as currently in progress or currently risky.",
    "In review and heartbeat turns, treat workgraph awaiting followups as historical context and source-thread hints only. Use current linear_list_review_facts as the authority for whether an issue is still open and currently risky.",
    "If workgraph awaiting followups conflicts with current Linear review facts, trust the current Linear facts and do not propose a new follow-up for a closed or absent issue.",
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
    "If the user asks what you can do, answer with 4-5 short bullets and a one-line closing invitation.",
    "For a what-you-can-do reply, cover these implemented capabilities only: Linear task management, existing issue execution through run_task, Notion search/create/update/archive, scheduler inspection and custom-job execution, and review/heartbeat/webhook automation.",
    "Do not mention unimplemented capabilities in a what-you-can-do reply.",
    "If the user asks whether you can mention or message another Slack user, interpret it as a question about your own outbound Slack capability, not as whether the user can mention you.",
    "Current explicit Slack mention-post support is limited to one explicit owner-map-resolved target per turn, posted either in the current thread or, when explicitly requested, to the control room root.",
    "Separately, review and heartbeat may mention one assignee in an internal follow-up notification when the current risk and policy justify it. Do not describe that as arbitrary message sending.",
    "DMs, arbitrary channels, multiple targets, and extra mention tokens are not supported for Slack outbound posts in this runtime.",
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

async function runIsolatedPromptTurn(
  config: AppConfig,
  paths: ThreadPaths,
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
): Promise<string> {
  const shared = await getSharedRuntime(config);
  const settingsManager = createLlmSettingsManager(shared.llmRuntimeConfig);

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
    thinkingLevel: shared.llmRuntimeConfig.effectiveThinkingLevel,
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    customTools: [],
  });
  session.agent.streamFn = wrapStreamFnWithMaxOutputTokens(
    session.agent.streamFn,
    shared.llmRuntimeConfig.maxOutputTokens,
  );

  const deltas: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(prompt);
    await session.agent.waitForIdle();
    const messages = session.messages as unknown[];
    const text = selectFinalAssistantText(messages, deltas);
    if (!text) {
      const llmFailure = findAssistantLlmFailure(messages);
      if (llmFailure) {
        throw new LlmProviderFailureError(llmFailure);
      }
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
      const resolved = await resolveLlmRuntimeDependencies(config);

      return {
        agentDir: resolved.agentDir,
        authStorage: resolved.authStorage,
        modelRegistry: resolved.modelRegistry,
        model: resolved.model,
        llmRuntimeConfig: resolved.runtimeConfig,
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
  const settingsManager = createLlmSettingsManager(shared.llmRuntimeConfig);

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
    thinkingLevel: shared.llmRuntimeConfig.effectiveThinkingLevel,
    authStorage: shared.authStorage,
    modelRegistry: shared.modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    customTools: createManagerAgentTools(config, shared.managerRepositories),
  });
  session.agent.streamFn = wrapStreamFnWithMaxOutputTokens(
    session.agent.streamFn,
    shared.llmRuntimeConfig.maxOutputTokens,
  );

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
  const capabilityQuery = detectSlackCapabilityQuery(normalized);
  const notionRecheck = shouldTreatAsNotionRecheck(normalized, lastQueryContext);
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

  if (notionRecheck) {
    hints.push("For notion.so links or same-page Notion re-checks, prefer Notion page/database tools over web_fetch_url.");
    hints.push("If an older reply summary says the Notion content was limited or only a few lines were visible, treat that summary as stale and re-read the current page with Notion tools.");
    if (/(?:全て|全文|全体|最後まで|残りも|全部)/.test(normalized)) {
      hints.push("If the current notion_get_page_content window says more lines are available, call it again with a later startLine instead of claiming the rest is unreadable.");
    }
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

  if (capabilityQuery?.type === "slack-outbound-mention") {
    hints.push("This is a capability question about outbound Slack mention behavior, not about whether the user can mention the assistant.");
    hints.push("Answer with the two supported surfaces: explicit send for one owner-map-resolved target per turn, and internal review / heartbeat follow-up mention when a response request is justified.");
    hints.push("Clarify that review / heartbeat mentions are internal follow-up notifications, not arbitrary message sending.");
    hints.push("Also mention the hard limits: no DMs, no arbitrary channels, no multiple targets, and no extra mention tokens.");
    hints.push("Do not switch to a generic what-you-can-do bullet list for this turn.");
  }

  return hints;
}

async function loadPromptCustomization(config: AppConfig): Promise<WorkspaceCustomizationContext> {
  return loadWorkspaceCustomization(buildSystemPaths(config.workspaceDir));
}

function hasNotionSignal(text: string | undefined): boolean {
  return /(?:notion|ノーション|アジェンダ)/i.test(text ?? "");
}

function shouldIncludeAgendaTemplateForManagerMessage(input: ManagerAgentInput): boolean {
  if (hasNotionSignal(input.text)) {
    return true;
  }
  if (hasNotionSignal(input.pendingClarification?.originalUserMessage)
    || hasNotionSignal(input.pendingClarification?.lastUserMessage)
    || hasNotionSignal(input.pendingClarification?.clarificationReply)) {
    return true;
  }
  return input.lastQueryContext?.referenceItems?.some((item) => (item.source ?? "").startsWith("notion")) ?? false;
}

function shouldIncludeAgendaTemplateForManagerSystem(input: ManagerSystemInput): boolean {
  if (hasNotionSignal(input.text)) {
    return true;
  }
  return Object.values(input.metadata ?? {}).some((value) => hasNotionSignal(value));
}

function detectWorkspaceConfigUpdateTarget(
  text: string | undefined,
): "agenda-template" | "heartbeat-prompt" | "owner-map" | undefined {
  const normalized = text?.trim();
  if (!normalized) return undefined;
  if (/(?:AGENDA_TEMPLATE\.md|agenda template)/i.test(normalized)) {
    return "agenda-template";
  }
  if (/(?:HEARTBEAT\.md|heartbeat prompt)/i.test(normalized)) {
    return "heartbeat-prompt";
  }
  if (/(?:owner-map(?:\.json)?|owner map)/i.test(normalized)) {
    return "owner-map";
  }
  return undefined;
}

function buildWorkspaceConfigUpdateHints(
  target: "agenda-template" | "heartbeat-prompt" | "owner-map" | undefined,
): string[] {
  if (target === "agenda-template") {
    return [
      "- The latest message explicitly targets AGENDA_TEMPLATE.md. Treat this as intent=update_workspace_config, not as a read-only query.",
      "- You may inspect prior agendas or Notion context first, but finish the turn with the workspace config proposal instead of a manual-edit instruction.",
      "- Read the current file with workspace_get_agenda_template before proposing the change.",
      "- Then use propose_replace_workspace_text_file with target=agenda-template. In this scope, AGENDA_TEMPLATE.md updates are full-file replacements.",
      "- Do not say that direct file editing is unavailable. The manager commit path for AGENDA_TEMPLATE.md is available in this runtime.",
    ];
  }
  if (target === "heartbeat-prompt") {
    return [
      "- The latest message explicitly targets HEARTBEAT.md. Treat this as intent=update_workspace_config, not as a read-only query.",
      "- Read the current file with workspace_get_heartbeat_prompt before proposing the change.",
      "- Then use propose_replace_workspace_text_file with target=heartbeat-prompt. In this scope, HEARTBEAT.md updates are full-file replacements.",
      "- Do not say that direct file editing is unavailable. The manager commit path for HEARTBEAT.md is available in this runtime.",
    ];
  }
  if (target === "owner-map") {
    return [
      "- The latest message explicitly targets owner-map.json. Treat this as intent=update_workspace_config, not as a read-only query.",
      "- Read the current file with workspace_get_owner_map before proposing the change.",
      "- Then use propose_update_owner_map with one structured operation instead of free-form JSON edits.",
      "- owner-map uses a preview-first path. The first turn may return a confirmation preview instead of an immediate commit.",
      "- Do not say that direct file editing is unavailable. The manager-owned structured update path for owner-map.json is available in this runtime.",
    ];
  }
  return [];
}

function buildSlackPostRequestHints(text: string | undefined): string[] {
  const request = text ? detectSlackOutboundPostRequest(text) : undefined;
  if (!request) {
    return [];
  }

  return [
    "- The latest message is an explicit outbound Slack post request, not a capability question.",
    "- Treat this as intent=post_slack_message.",
    "- Read owner-map.json first with workspace_get_owner_map and resolve exactly one target by exact-match on entry.id, linearAssignee, or slackUserId after trim, lowercase, and whitespace normalization.",
    "- If owner-map resolution is zero-match or multi-match, ask one short clarification question instead of proposing a mutation.",
    request.destination === "control-room-root"
      ? "- The user explicitly asked for control room, so use destination=control-room-root."
      : "- Default to destination=current-thread because the user did not explicitly ask for control room.",
    "- Use propose_post_slack_message with exactly one target and one message. messageText must exclude the target mention token and any extra mention tokens.",
  ];
}

function buildCapabilityQueryHints(text: string | undefined): string[] {
  const capabilityQuery = text ? detectSlackCapabilityQuery(text) : undefined;
  if (capabilityQuery?.type !== "slack-outbound-mention") {
    return [];
  }

  return [
    "- The latest message is a capability question about outbound Slack mention behavior.",
    "- Do not reinterpret this as whether the user can mention the assistant.",
    "- Answer with the two supported surfaces: explicit send for one owner-map-resolved target per turn, and internal review / heartbeat follow-up mention when a response request is justified.",
    "- Clarify that review / heartbeat mentions are internal follow-up notifications, not arbitrary message sending.",
    "- Also mention the unsupported cases: DM, arbitrary channel, multiple targets, and extra mention tokens.",
    "- Do not turn this into a generic what-you-can-do bullet list unless the user broadens the question.",
  ];
}

export function buildManagerAgentPrompt(input: ManagerAgentInput): string {
  const notionRecheck = shouldTreatAsNotionRecheck(input.text, input.lastQueryContext);
  const styleHints = buildManagerReplyStyleHints(input.text, input.lastQueryContext, input.pendingClarification)
    .map((hint) => `- ${hint}`);
  const greetingHints = buildSlackGreetingPromptHints({
    messageText: input.text,
    currentDateTimeJst: input.currentDateTimeJst,
  }).map((hint) => `- ${hint}`);
  const capabilityQueryHints = buildCapabilityQueryHints(input.text);
  const slackPostRequestHints = buildSlackPostRequestHints(input.text);
  const workspaceConfigUpdateHints = buildWorkspaceConfigUpdateHints(
    detectWorkspaceConfigUpdateTarget(input.text),
  );
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
        ...(notionRecheck
          ? ["- previousReplySummaryHandling: ignore stale prior summary for this Notion re-check; use Notion tools as the source of truth."]
          : []),
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
  const pendingConfirmationLines = input.pendingConfirmation
    ? [
        `- kind: ${input.pendingConfirmation.kind}`,
        `- originalUserMessage: ${input.pendingConfirmation.originalUserMessage}`,
        `- previewSummaryLines: ${input.pendingConfirmation.previewSummaryLines.join(" | ") || "(none)"}`,
        `- proposalCount: ${input.pendingConfirmation.proposals.length}`,
        `- recordedAt: ${input.pendingConfirmation.recordedAt}`,
      ]
    : ["- (none)"];
  const currentThreadNotionPageLines = input.currentThreadNotionPageTarget
    ? [
        `- pageId: ${input.currentThreadNotionPageTarget.pageId}`,
        `- title: ${input.currentThreadNotionPageTarget.title ?? "(none)"}`,
        `- url: ${input.currentThreadNotionPageTarget.url ?? "(none)"}`,
        `- recordedAt: ${input.currentThreadNotionPageTarget.recordedAt}`,
      ]
    : ["- (none)"];
  const workspaceAgentsSection = input.workspaceAgents
    ? [
        "",
        "Runtime workspace AGENTS:",
        ...input.workspaceAgents.split("\n"),
      ]
    : [];
  const workspaceMemorySection = input.workspaceMemory
    ? [
        "",
        "Workspace memory:",
        ...input.workspaceMemory.split("\n"),
      ]
    : [];
  const agendaTemplateSection = input.agendaTemplate
    ? [
        "",
        "Notion agenda template:",
        ...input.agendaTemplate.split("\n"),
      ]
    : [];
  return [
    "Manager message context:",
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- sourceMessageTs: ${input.messageTs}`,
    `- userId: ${input.userId}`,
    `- currentDateJst: ${input.currentDate}`,
    `- currentDateTimeJst: ${input.currentDateTimeJst ?? "(none)"}`,
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
    "Pending manager confirmation context:",
    ...pendingConfirmationLines,
    "",
    "Current thread Notion page target:",
    ...currentThreadNotionPageLines,
    ...workspaceAgentsSection,
    ...workspaceMemorySection,
    ...agendaTemplateSection,
    "",
    "Public reply style hints:",
    ...styleHints,
    ...(greetingHints.length > 0
      ? [
          "",
          "Greeting hints:",
          ...greetingHints,
        ]
      : []),
    ...(capabilityQueryHints.length > 0
      ? [
          "",
          "Capability query hints:",
          ...capabilityQueryHints,
        ]
      : []),
    ...(slackPostRequestHints.length > 0
      ? [
          "",
          "Slack post request hints:",
          ...slackPostRequestHints,
        ]
      : []),
    ...(workspaceConfigUpdateHints.length > 0
      ? [
          "",
          "Workspace config update hints:",
          ...workspaceConfigUpdateHints,
        ]
      : []),
  ].join("\n");
}

export function buildManagerSystemPromptInput(input: ManagerSystemInput): string {
  const metadataLines = Object.entries(input.metadata ?? {})
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  const workspaceAgentsSection = input.workspaceAgents
    ? [
        "",
        "Runtime workspace AGENTS:",
        ...input.workspaceAgents.split("\n"),
      ]
    : [];
  const workspaceMemorySection = input.workspaceMemory
    ? [
        "",
        "Workspace memory:",
        ...input.workspaceMemory.split("\n"),
      ]
    : [];
  const agendaTemplateSection = input.agendaTemplate
    ? [
        "",
        "Notion agenda template:",
        ...input.agendaTemplate.split("\n"),
      ]
    : [];

  return [
    "Manager system task context:",
    `- runKind: ${input.kind}`,
    `- channelId: ${input.channelId}`,
    `- rootThreadTs: ${input.rootThreadTs}`,
    `- sourceMessageTs: ${input.messageTs}`,
    `- currentDateJst: ${input.currentDate}`,
    `- runAtJst: ${input.runAtJst}`,
    ...(metadataLines ? ["", "Metadata:", metadataLines] : []),
    ...workspaceAgentsSection,
    ...workspaceMemorySection,
    ...agendaTemplateSection,
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
  const { workspaceAgents, workspaceMemory } = await loadPromptCustomization(config);
  return runResearchSynthesisTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    {
      ...input,
      workspaceAgents,
      workspaceMemory,
    },
  );
}

export async function runMessageRouterTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: MessageRouterInput,
): Promise<MessageRouterResult> {
  const { workspaceAgents, workspaceMemory } = await loadPromptCustomization(config);
  return runMessageRouterTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    {
      ...input,
      workspaceAgents,
      workspaceMemory,
    },
  );
}

export async function runManagerReplyTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerReplyInput,
): Promise<ManagerReplyResult> {
  const { workspaceAgents, workspaceMemory } = await loadPromptCustomization(config);
  return runManagerReplyTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    {
      ...input,
      workspaceAgents,
      workspaceMemory,
    },
  );
}

export async function runTaskPlanningTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: TaskPlanningInput,
): Promise<TaskPlanningResult> {
  const { workspaceAgents, workspaceMemory } = await loadPromptCustomization(config);
  return runTaskPlanningTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    {
      ...input,
      workspaceAgents,
      workspaceMemory,
    },
  );
}

export async function runFollowupResolutionTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: FollowupResolutionInput,
): Promise<FollowupResolutionResult> {
  const { workspaceAgents, workspaceMemory } = await loadPromptCustomization(config);
  return runFollowupResolutionTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    {
      ...input,
      workspaceAgents,
      workspaceMemory,
    },
  );
}

export async function runPersonalizationExtractionTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: PersonalizationExtractionInput,
): Promise<PersonalizationExtractionResult> {
  const { workspaceAgents, workspaceMemory } = await loadPromptCustomization(config);
  return runPersonalizationExtractionTurnWithExecutor(
    (prompt, systemPrompt, sessionSuffix) => runIsolatedPromptTurn(
      config,
      paths,
      prompt,
      systemPrompt,
      sessionSuffix,
    ),
    {
      ...input,
      workspaceAgents,
      workspaceMemory,
    },
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
    const reply = selectFinalAssistantText(newMessages, deltas);
    if (!reply) {
      const llmFailure = findAssistantLlmFailure(newMessages);
      if (llmFailure) {
        throw new LlmProviderFailureError(llmFailure);
      }
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
  const customization = await loadPromptCustomization(config);
  return runStructuredPromptTurn(config, paths, buildManagerAgentPrompt({
    ...input,
    workspaceAgents: customization.workspaceAgents,
    workspaceMemory: customization.workspaceMemory,
    agendaTemplate: shouldIncludeAgendaTemplateForManagerMessage(input)
      ? customization.agendaTemplate
      : undefined,
  }));
}

export async function runManagerSystemTurn(
  config: AppConfig,
  paths: ThreadPaths,
  input: ManagerSystemInput,
): Promise<ManagerAgentTurnResult> {
  const customization = await loadPromptCustomization(config);
  return runStructuredPromptTurn(config, paths, buildManagerSystemPromptInput({
    ...input,
    workspaceAgents: customization.workspaceAgents,
    workspaceMemory: customization.workspaceMemory,
    agendaTemplate: shouldIncludeAgendaTemplateForManagerSystem(input)
      ? customization.agendaTemplate
      : undefined,
  }));
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
    const text = selectFinalAssistantText(newMessages, deltas);
    if (!text) {
      const llmFailure = findAssistantLlmFailure(newMessages);
      if (llmFailure) {
        throw new LlmProviderFailureError(llmFailure);
      }
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
