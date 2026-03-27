import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  findLinearDuplicateCandidates,
  type LinearDuplicateCandidate,
} from "./linear-duplicate-candidates.js";
import {
  getLinearIssue,
  listOpenLinearIssues,
  listLinearTeamMembers,
  searchLinearIssues,
  type LinearIssue,
  type LinearCommandEnv,
} from "./linear.js";
import {
  getNotionDatabaseFacts,
  getNotionPageContent,
  getNotionPageFacts,
  listNotionDatabases,
  queryNotionDatabase,
  searchNotionDatabases,
  searchNotionPages,
  type NotionCommandEnv,
} from "./notion.js";
import { loadManagerPolicy } from "./manager-state.js";
import {
  getUnifiedSchedule,
  listUnifiedSchedules,
  type SchedulerScheduleView,
} from "./scheduler-management.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import {
  buildSystemPaths,
  readAgendaTemplate,
  readHeartbeatInstructions,
} from "./system-workspace.js";
import { webFetchUrl, webSearchFetch } from "./web-research.js";
import { createWorkgraphReadTools } from "./workgraph-tools.js";
import { analyzeOwnerMap } from "./owner-map-diagnostics.js";
import type { OwnerMap } from "../state/manager-state-contract.js";
import {
  managerCommandProposalSchema,
  managerIntentReportSchema,
  type ManagerCommandProposal,
  type ManagerIntentReport,
  type PendingClarificationDecisionReport,
  type TaskExecutionDecisionReport,
} from "./manager-command-commit.js";

function buildLinearEnv(config: AppConfig): LinearCommandEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
}

function buildNotionEnv(config: AppConfig): NotionCommandEnv {
  return {
    ...process.env,
    NOTION_API_TOKEN: config.notionApiToken,
  };
}

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatIssue(issue: { identifier: string; title: string; url?: string | null }): string {
  return issue.url ? `${issue.identifier} ${issue.title}\n${issue.url}` : `${issue.identifier} ${issue.title}`;
}

function formatDuplicateCandidate(candidate: LinearDuplicateCandidate): string {
  return [
    formatIssue(candidate),
    `matchedQueries: ${candidate.matchedQueries.join(" | ")}`,
    `matchedTokenCount: ${candidate.matchedTokenCount}`,
    candidate.state ? `state: ${candidate.state}` : undefined,
    candidate.updatedAt ? `updatedAt: ${candidate.updatedAt}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatDateLabel(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatNotionPageLabel(page: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
}): string {
  const title = page.title?.trim() || "Untitled";
  const linkedTitle = page.url ? `[${title}](${page.url})` : title;
  const edited = formatDateLabel(page.lastEditedTime);
  return edited ? `${linkedTitle}（最終更新: ${edited}）` : linkedTitle;
}

function formatNotionSearchResultText(
  pages: Array<{
    title?: string;
    url?: string | null;
    lastEditedTime?: string | null;
  }>,
): string {
  if (pages.length === 0) {
    return "No matching Notion pages found.";
  }
  return [
    "Notion pages:",
    ...pages.map((page) => `- ${formatNotionPageLabel(page)}`),
  ].join("\n");
}

function formatNotionPageFactsText(page: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  createdTime?: string | null;
  archived?: boolean;
  inTrash?: boolean;
}): string {
  return [
    `Title: ${formatNotionPageLabel(page)}`,
    page.createdTime ? `Created: ${formatDateLabel(page.createdTime)}` : undefined,
    page.archived ? "Archived: yes" : undefined,
    page.inTrash ? "In trash: yes" : undefined,
  ].filter(Boolean).join("\n");
}

const DEFAULT_NOTION_PAGE_WINDOW_LINES = 80;
const MAX_NOTION_PAGE_WINDOW_LINES = 120;

function formatNotionPageContentText(page: {
  title?: string;
  url?: string | null;
  excerpt?: string;
  lines?: Array<{ text?: string }>;
}, options?: { startLine?: number; maxLines?: number }): string {
  const allBodyLines = (page.lines ?? [])
    .map((line) => line.text?.trim())
    .filter((line): line is string => Boolean(line));
  const requestedStartLine = Number.isFinite(options?.startLine) ? Math.trunc(options!.startLine!) : 1;
  const requestedMaxLines = Number.isFinite(options?.maxLines) ? Math.trunc(options!.maxLines!) : DEFAULT_NOTION_PAGE_WINDOW_LINES;
  const safeStartLine = Math.max(1, requestedStartLine);
  const safeMaxLines = Math.min(MAX_NOTION_PAGE_WINDOW_LINES, Math.max(1, requestedMaxLines));
  const startIndex = Math.min(allBodyLines.length, safeStartLine - 1);
  const windowLines = allBodyLines.slice(startIndex, startIndex + safeMaxLines);
  const startLabel = windowLines.length > 0 ? startIndex + 1 : 0;
  const endLabel = startIndex + windowLines.length;
  return [
    `Title: ${formatNotionPageLabel(page)}`,
    page.excerpt ? `Excerpt: ${page.excerpt}` : undefined,
    allBodyLines.length > 0
      ? `Extracted page lines: ${allBodyLines.length} total. The lines below are the current display window, not a hard retrieval limit.`
      : undefined,
    ...(windowLines.length > 0
      ? [
          `Page lines (${startLabel}-${endLabel} of ${allBodyLines.length}):`,
          ...windowLines.map((line) => `- ${line}`),
          ...(allBodyLines.length > endLabel
            ? [`More lines are available. Call notion_get_page_content again with startLine=${endLabel + 1} to continue reading this page.`]
            : []),
        ]
      : []),
  ].filter(Boolean).join("\n");
}

function formatNotionDatabaseLabel(database: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  description?: string;
}): string {
  const title = database.title?.trim() || "Untitled database";
  const linkedTitle = database.url ? `[${title}](${database.url})` : title;
  const edited = formatDateLabel(database.lastEditedTime);
  const description = database.description?.trim();
  const suffix = [edited ? `最終更新: ${edited}` : undefined, description].filter(Boolean).join(" / ");
  return suffix ? `${linkedTitle}（${suffix}）` : linkedTitle;
}

function formatNotionDatabaseSearchResultText(
  databases: Array<{
    title?: string;
    url?: string | null;
    lastEditedTime?: string | null;
    description?: string;
  }>,
): string {
  if (databases.length === 0) {
    return "No matching Notion databases found.";
  }
  return [
    "Notion databases:",
    ...databases.map((database) => `- ${formatNotionDatabaseLabel(database)}`),
  ].join("\n");
}

function formatNotionDatabaseRow(row: {
  title?: string;
  url?: string | null;
  properties?: Record<string, unknown>;
}): string {
  const title = row.title?.trim() || "Untitled row";
  const linkedTitle = row.url ? `[${title}](${row.url})` : title;
  const propertySummary = Object.entries(row.properties ?? {})
    .slice(0, 4)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}: ${value.join(", ")}`;
      }
      if (value && typeof value === "object") {
        return `${key}: ${formatJsonDetails(value)}`;
      }
      return `${key}: ${String(value)}`;
    })
    .join(" / ");
  return propertySummary ? `${linkedTitle}（${propertySummary}）` : linkedTitle;
}

function formatNotionDatabaseQueryText(result: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  description?: string;
  properties?: Record<string, { type?: string; options?: string[] }>;
  rows: Array<{
    title?: string;
    url?: string | null;
    properties?: Record<string, unknown>;
  }>;
}): string {
  const propertySummary = Object.entries(result.properties ?? {})
    .slice(0, 6)
    .map(([name, schema]) => {
      const options = Array.isArray(schema.options) && schema.options.length > 0
        ? ` (${schema.options.join(", ")})`
        : "";
      return `- ${name}: ${schema.type ?? "unknown"}${options}`;
    });
  return [
    `Database: ${formatNotionDatabaseLabel(result)}`,
    ...(propertySummary.length > 0 ? ["Properties:", ...propertySummary] : []),
    result.rows.length > 0
      ? ["Rows:", ...result.rows.slice(0, 5).map((row) => `- ${formatNotionDatabaseRow(row)}`)].join("\n")
      : "Rows: (none)",
  ].join("\n");
}

function formatNotionDatabaseFactsText(database: {
  title?: string;
  url?: string | null;
  lastEditedTime?: string | null;
  description?: string;
  properties?: Record<string, { type?: string; options?: string[] }>;
}): string {
  const properties = Object.entries(database.properties ?? {})
    .slice(0, 12)
    .map(([name, schema]) => {
      const options = Array.isArray(schema.options) && schema.options.length > 0
        ? ` (${schema.options.join(", ")})`
        : "";
      return `- ${name}: ${schema.type ?? "unknown"}${options}`;
    });
  return [
    `Database: ${formatNotionDatabaseLabel(database)}`,
    ...(properties.length > 0 ? ["Properties:", ...properties] : []),
  ].join("\n");
}

function formatScheduleLabel(view: SchedulerScheduleView): string {
  if (view.kind === "custom-job") {
    return view.id;
  }
  if (view.kind === "morning-review") return "朝レビュー";
  if (view.kind === "evening-review") return "夕方レビュー";
  if (view.kind === "weekly-review") return "週次レビュー";
  return "heartbeat";
}

function formatScheduleTiming(view: SchedulerScheduleView): string {
  if (view.scheduleType === "heartbeat") {
    return `${view.intervalMin ?? 0}分ごと`;
  }
  if (view.scheduleType === "daily") {
    return `毎日 ${view.time}`;
  }
  if (view.scheduleType === "weekly") {
    return `毎週 ${view.weekday} ${view.time}`;
  }
  if (view.scheduleType === "every") {
    return `${view.everySec}秒ごと`;
  }
  return view.at ?? "単発実行";
}

function formatScheduleViewText(view: SchedulerScheduleView): string {
  return [
    `${formatScheduleLabel(view)} (${view.id})`,
    `- enabled: ${view.enabled ? "yes" : "no"}`,
    `- source: ${view.source}`,
    `- channel: ${view.channelLabel} (${view.channelId})`,
    `- schedule: ${formatScheduleTiming(view)}`,
    `- prompt: ${view.prompt}`,
    view.nextRunAt ? `- nextRunAt: ${view.nextRunAt}` : undefined,
    view.lastRunAt ? `- lastRunAt: ${view.lastRunAt}` : undefined,
    view.lastStatus ? `- lastStatus: ${view.lastStatus}` : undefined,
    view.lastError ? `- lastError: ${view.lastError}` : undefined,
  ].filter(Boolean).join("\n");
}

function businessDaysSince(leftIso: string | null | undefined, right = new Date()): number | undefined {
  if (!leftIso) return undefined;
  const start = new Date(leftIso);
  if (Number.isNaN(start.getTime())) return undefined;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const end = new Date(right);
  end.setHours(0, 0, 0, 0);
  if (current >= end) return 0;

  let days = 0;
  while (current < end) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      days += 1;
    }
  }
  return days;
}

function toJstDayKey(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseDayKey(value: string | null | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (!year || !month || !day) return undefined;
  return new Date(Date.UTC(year, month - 1, day));
}

function dueRelativeInfo(
  dueDate: string | null | undefined,
  right = new Date(),
): { daysUntilDue?: number; dueRelativeLabel?: string } {
  const due = parseDayKey(dueDate);
  const today = parseDayKey(toJstDayKey(right));
  if (!due || !today) {
    return {};
  }
  const diffDays = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) {
    return {
      daysUntilDue: diffDays,
      dueRelativeLabel: `${Math.abs(diffDays)}日超過`,
    };
  }
  if (diffDays === 0) {
    return {
      daysUntilDue: 0,
      dueRelativeLabel: "今日",
    };
  }
  if (diffDays === 1) {
    return {
      daysUntilDue: 1,
      dueRelativeLabel: "明日",
    };
  }
  return {
    daysUntilDue: diffDays,
    dueRelativeLabel: `${diffDays}日後`,
  };
}

function overdueDays(dueDate: string | null | undefined, right = new Date()): number | undefined {
  if (!dueDate) return undefined;
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return undefined;
  const today = new Date(Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate()));
  const diffMs = today.getTime() - due.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function isOpenLinearState(state: LinearIssue["state"] | null | undefined): boolean {
  const type = state?.type?.toLowerCase();
  const name = state?.name?.toLowerCase();
  return type !== "done" && type !== "completed" && type !== "canceled"
    && name !== "done" && name !== "completed" && name !== "canceled";
}

function buildIssueFacts(issue: LinearIssue): Record<string, unknown> {
  const blockedState = issue.state?.name?.toLowerCase() === "blocked";
  const blockedByDependency = (issue.inverseRelations ?? []).some((relation) => relation.type === "blocked-by");
  const recentBlockedUpdate = issue.latestActionKind === "blocked";
  const relativeDue = dueRelativeInfo(issue.dueDate);
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    description: issue.description ?? undefined,
    state: issue.state ?? undefined,
    stateName: issue.state?.name ?? undefined,
    stateType: issue.state?.type ?? undefined,
    completedAt: issue.completedAt ?? undefined,
    isOpen: isOpenLinearState(issue.state),
    dueDate: issue.dueDate ?? undefined,
    priority: issue.priority ?? undefined,
    priorityLabel: issue.priorityLabel ?? undefined,
    cycle: issue.cycle ?? undefined,
    updatedAt: issue.updatedAt ?? undefined,
    assignee: issue.assignee ?? undefined,
    parent: issue.parent ?? undefined,
    children: issue.children ?? [],
    relations: issue.relations ?? [],
    inverseRelations: issue.inverseRelations ?? [],
    latestActionKind: issue.latestActionKind ?? undefined,
    latestActionAt: issue.latestActionAt ?? undefined,
    overdueDays: overdueDays(issue.dueDate),
    daysUntilDue: relativeDue.daysUntilDue,
    dueRelativeLabel: relativeDue.dueRelativeLabel,
    staleBusinessDays: businessDaysSince(issue.updatedAt),
    commentCount: issue.comments?.length ?? 0,
    comments: issue.comments?.slice(0, 10).map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt ?? undefined,
      user: comment.user ?? undefined,
    })) ?? [],
    ownerMissing: !issue.assignee,
    dueMissing: !issue.dueDate,
    blockedSignals: {
      blockedState,
      blockedByDependency,
      recentBlockedUpdate,
    },
  };
}

async function buildReviewIssueFacts(
  issue: LinearIssue,
  env: LinearCommandEnv,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const base = buildIssueFacts(issue);
  const childIds = (issue.children ?? []).map((child) => child.identifier).filter(Boolean);
  if (childIds.length === 0) {
    return {
      ...base,
      openChildren: [],
      closedChildren: [],
    };
  }

  const children = (await Promise.all(
    childIds.map(async (issueId) => {
      try {
        const child = await getLinearIssue(issueId, env, signal);
        return buildIssueFacts(child);
      } catch {
        return {
          identifier: issueId,
          title: (issue.children ?? []).find((child) => child.identifier === issueId)?.title,
        };
      }
    }),
  ));

  return {
    ...base,
    children,
    openChildren: children.filter((child) => child.isOpen !== false),
    closedChildren: children.filter((child) => child.isOpen === false),
  };
}

function createIntentReportTool(): ToolDefinition {
  return {
    name: "report_manager_intent",
    label: "Report Manager Intent",
    description: "Record the current high-level intent before or during tool usage. Use this once per turn.",
    promptSnippet: "Call this early to tell the manager what kind of turn this is.",
    parameters: Type.Object({
      intent: Type.String({ description: "conversation | query | query_schedule | run_task | create_work | create_schedule | run_schedule | update_progress | update_completed | update_blocked | update_schedule | delete_schedule | followup_resolution | update_workspace_config | post_slack_message | review | heartbeat | scheduler" }),
      queryKind: Type.Optional(Type.String({ description: "Optional query subtype: list-active | list-today | what-should-i-do | inspect-work | search-existing | recommend-next-step | reference-material." })),
      queryScope: Type.Optional(Type.String({ description: "Optional query scope self | team | thread-context." })),
      conversationKind: Type.Optional(Type.String({ description: "Required when intent=conversation: greeting | smalltalk | other." })),
      confidence: Type.Optional(Type.Number({ description: "Confidence between 0 and 1." })),
      summary: Type.Optional(Type.String({ description: "One short sentence explaining the intent." })),
    }),
    async execute(_toolCallId, params) {
      const typed = managerIntentReportSchema.parse(params) as ManagerIntentReport;
      return {
        content: [{ type: "text", text: "Intent recorded." }],
        details: { intentReport: typed },
      };
    },
  };
}

function createTaskExecutionDecisionTool(): ToolDefinition {
  return {
    name: "report_task_execution_decision",
    label: "Report Task Execution Decision",
    description: "Record whether an imperative issue-execution request should execute now or no-op, and why it is executable or not executable.",
    promptSnippet: "Use this after you inspect the target issue. The summary should explain why there is a clear executable action now, or why no executable manager action exists.",
    parameters: Type.Object({
      decision: Type.String({ description: "execute | noop" }),
      targetIssueId: Type.Optional(Type.String({ description: "Resolved target issue id when known." })),
      targetIssueIdentifier: Type.Optional(Type.String({ description: "Resolved target issue identifier like AIC-123 when known." })),
      summary: Type.Optional(Type.String({ description: "One short sentence explaining why this is executable or not executable." })),
    }),
    async execute(_toolCallId, params) {
      const typed = params as TaskExecutionDecisionReport;
      return {
        content: [{ type: "text", text: "Task execution decision recorded." }],
        details: { taskExecutionDecision: typed },
      };
    },
  };
}

function createQuerySnapshotTool(): ToolDefinition {
  return {
    name: "report_query_snapshot",
    label: "Report Query Snapshot",
    description: "Record which items were shown in a query reply and what remains available for continuation.",
    promptSnippet: "Use this once for every query reply. Include referenceItems for Notion/docs/web replies when documents, pages, or databases were surfaced.",
    parameters: Type.Object({
      issueIds: Type.Array(Type.String({ description: "Issue IDs explicitly shown in this reply." })),
      shownIssueIds: Type.Array(Type.String({ description: "All issue IDs already shown in this query chain, including this reply." })),
      remainingIssueIds: Type.Array(Type.String({ description: "Relevant issue IDs not yet shown but still candidates for a follow-up like 他には?" })),
      totalItemCount: Type.Number({ description: "Total number of relevant issues in this query result set." }),
      replySummary: Type.String({ description: "One short sentence summarizing the reply." }),
      scope: Type.String({ description: "self | team | thread-context" }),
      referenceItems: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ description: "Stable identifier for the referenced document, page, or database." }),
        title: Type.Optional(Type.String({ description: "Human-readable title." })),
        url: Type.Optional(Type.String({ description: "Canonical URL when available." })),
        source: Type.Optional(Type.String({ description: "Origin such as notion, notion-database, web, slack, or docs." })),
      }))),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Query snapshot recorded." }],
        details: { querySnapshot: params as Record<string, unknown> },
      };
    },
  };
}

function createPendingClarificationDecisionTool(): ToolDefinition {
  return {
    name: "report_pending_clarification_decision",
    label: "Report Pending Clarification Decision",
    description: "Record whether the latest message continues a pending clarification, asks for its status, starts a new request, or clears the pending state.",
    promptSnippet: "Use this once when a pending manager clarification context exists for the thread.",
    parameters: Type.Object({
      decision: Type.String({ description: "continue_pending | status_question | new_request | clear_pending" }),
      persistence: Type.String({ description: "keep | replace | clear. Use replace when this turn should create or overwrite the pending clarification state." }),
      summary: Type.Optional(Type.String({ description: "One short sentence explaining why." })),
    }),
    async execute(_toolCallId, params) {
      const typed = params as PendingClarificationDecisionReport;
      return {
        content: [{ type: "text", text: "Pending clarification decision recorded." }],
        details: { pendingClarificationDecision: typed },
      };
    },
  };
}

function createProposalTool(args: {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: ReturnType<typeof Type.Object>;
  commandType: ManagerCommandProposal["commandType"];
}): ToolDefinition {
  return {
    name: args.name,
    label: args.label,
    description: args.description,
    promptSnippet: args.promptSnippet,
    parameters: args.parameters,
    async execute(_toolCallId, params) {
      const proposal = managerCommandProposalSchema.parse({
        commandType: args.commandType,
        ...(params as Record<string, unknown>),
      });
      return {
        content: [{ type: "text", text: "Command proposal recorded." }],
        details: { proposal },
      };
    },
  };
}

function createLinearReadTools(
  config: AppConfig,
): ToolDefinition[] {
  const env = buildLinearEnv(config);

  return [
    {
      name: "linear_list_active_issue_facts",
      label: "Linear List Active Issue Facts",
      description: "List active Linear issues as raw facts for query, prioritization, and next-step reasoning.",
      promptSnippet: "Use this for task lists and broad active-work queries. Decide prioritization yourself from the returned facts.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of issues to fetch." })),
      }),
      async execute(_toolCallId, params, signal) {
        const issues = await listOpenLinearIssues(env, signal);
        const limited = issues.slice(0, (params as { limit?: number }).limit ?? 20).map((issue) => buildIssueFacts(issue));
        return {
          content: [{ type: "text", text: limited.length > 0 ? formatJsonDetails(limited) : "No active issue facts found." }],
          details: limited,
        };
      },
    },
    {
      name: "linear_list_review_facts",
      label: "Linear List Review Facts",
      description: "List active Linear issues with raw review-oriented facts such as overdueDays, staleBusinessDays, blockedSignals, ownerMissing, and dueMissing.",
      promptSnippet: "Use this for review, heartbeat, and next-step suggestions. Select the important issues yourself from the facts and treat openChildren as current work while keeping closedChildren only for improvement notes.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of issues to fetch." })),
      }),
      async execute(_toolCallId, _params, signal) {
        const issues = await listOpenLinearIssues(env, signal);
        const limit = (_params as { limit?: number } | undefined)?.limit ?? 50;
        const facts = await Promise.all(
          issues.slice(0, limit).map((issue) => buildReviewIssueFacts(issue, env, signal)),
        );
        return {
          content: [{ type: "text", text: facts.length > 0 ? formatJsonDetails(facts) : "No review facts found." }],
          details: facts,
        };
      },
    },
    {
      name: "linear_get_issue_facts",
      label: "Linear Get Issue Facts",
      description: "Load one Linear issue and return raw facts including hierarchy, relations, comments, and review signals.",
      promptSnippet: "Use this for inspect-work and next-step reasoning. Decide the next step yourself from the returned facts.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
      }),
      async execute(_toolCallId, params, signal) {
        const issue = await getLinearIssue((params as { issueId: string }).issueId, env, signal, { includeComments: true });
        return {
          content: [{ type: "text", text: formatJsonDetails(buildIssueFacts(issue)) }],
          details: buildIssueFacts(issue),
        };
      },
    },
    {
      name: "linear_search_issues",
      label: "Linear Search Issues",
      description: "Search existing issues to inspect duplicates or related work.",
      promptSnippet: "Use this before proposing new tracked work or when searching existing issues.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
        states: Type.Optional(Type.Array(Type.String({ description: "Optional state filters." }))),
      }),
      async execute(_toolCallId, params, signal) {
        const issues = await searchLinearIssues(params as { query: string; limit?: number; states?: string[] }, env, signal);
        return {
          content: [{ type: "text", text: issues.length > 0 ? issues.map(formatIssue).join("\n\n") : "No matching issues found." }],
          details: issues,
        };
      },
    },
    {
      name: "linear_find_duplicate_candidates",
      label: "Linear Find Duplicate Candidates",
      description: "Search likely duplicate active issues for one requested work item using deterministic query variants.",
      promptSnippet: "Use this before create_work when deciding whether one requested item should create new work, reuse an existing issue, or ask for clarification.",
      parameters: Type.Object({
        text: Type.String({ description: "One requested work item title or short description." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of candidates to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const candidates = await findLinearDuplicateCandidates(
          params as { text: string; limit?: number },
          env,
          signal,
        );
        return {
          content: [{
            type: "text",
            text: candidates.length > 0
              ? ["Duplicate candidates:", ...candidates.map((candidate) => `- ${formatDuplicateCandidate(candidate).replace(/\n/g, "\n  ")}`)].join("\n")
              : "No duplicate candidates found.",
          }],
          details: candidates,
        };
      },
    },
    {
      name: "linear_list_team_members",
      label: "Linear List Team Members",
      description: "List active team members to reason about assignees.",
      promptSnippet: "Use this when proposing assignment or checking who owns a task.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        const members = await listLinearTeamMembers(env, signal);
        return {
          content: [{ type: "text", text: members.length > 0 ? formatJsonDetails(members) : "No active team members found." }],
          details: members,
        };
      },
    },
  ];
}

function createNotionReadTools(config: AppConfig): ToolDefinition[] {
  const env = buildNotionEnv(config);

  return [
    {
      name: "notion_search_pages",
      label: "Notion Search Pages",
      description: "Search Notion pages as raw facts. Read-only.",
      promptSnippet: "Use this when Notion may contain relevant specs, notes, or operating context for the current task.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of pages to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const pages = await searchNotionPages(params as { query: string; pageSize?: number }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionSearchResultText(pages) }],
          details: pages,
        };
      },
    },
    {
      name: "notion_list_databases",
      label: "Notion List Databases",
      description: "List accessible Notion databases as raw facts. Read-only.",
      promptSnippet: "Use this when the user asks for Notion databases without a specific keyword or wants to browse which databases are available.",
      parameters: Type.Object({
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of databases to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const databases = await listNotionDatabases(params as { pageSize?: number }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseSearchResultText(databases) }],
          details: databases,
        };
      },
    },
    {
      name: "notion_search_databases",
      label: "Notion Search Databases",
      description: "Search Notion databases as raw facts. Read-only.",
      promptSnippet: "Use this when the answer likely lives in a structured Notion database rather than a page.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of databases to return." })),
      }),
      async execute(_toolCallId, params, signal) {
        const databases = await searchNotionDatabases(params as { query: string; pageSize?: number }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseSearchResultText(databases) }],
          details: databases,
        };
      },
    },
    {
      name: "notion_get_page_facts",
      label: "Notion Get Page Facts",
      description: "Load one Notion page as raw facts. Read-only.",
      promptSnippet: "Use this after selecting a relevant Notion page from search results.",
      parameters: Type.Object({
        pageId: Type.String({ description: "Notion page ID." }),
      }),
      async execute(_toolCallId, params, signal) {
        const page = await getNotionPageFacts((params as { pageId: string }).pageId, env, signal);
        return {
          content: [{ type: "text", text: formatNotionPageFactsText(page) }],
          details: page,
        };
      },
    },
    {
      name: "notion_get_page_content",
      label: "Notion Get Page Content",
      description: "Load one Notion page and extract read-only content lines and a short excerpt.",
      promptSnippet: "Use this when metadata is not enough and you need the actual Notion page contents.",
      parameters: Type.Object({
        pageId: Type.String({ description: "Notion page ID." }),
        startLine: Type.Optional(Type.Number({ description: "Optional 1-based line number to start from when continuing through a longer page." })),
        maxLines: Type.Optional(Type.Number({ description: "Optional number of lines to show in this window. Defaults to 80 and caps at 120." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { pageId: string; startLine?: number; maxLines?: number };
        const page = await getNotionPageContent(typedParams.pageId, env, signal);
        return {
          content: [{ type: "text", text: formatNotionPageContentText(page, typedParams) }],
          details: page,
        };
      },
    },
    {
      name: "notion_get_database_facts",
      label: "Notion Get Database Facts",
      description: "Load one Notion database and return its schema as raw facts. Read-only.",
      promptSnippet: "Use this before filtering or sorting a Notion database so you know the property names and types.",
      parameters: Type.Object({
        databaseId: Type.String({ description: "Notion database ID." }),
      }),
      async execute(_toolCallId, params, signal) {
        const database = await getNotionDatabaseFacts((params as { databaseId: string }).databaseId, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseFactsText(database) }],
          details: database,
        };
      },
    },
    {
      name: "notion_query_database",
      label: "Notion Query Database",
      description: "Load one Notion database and return a small read-only row sample.",
      promptSnippet: "Use this after selecting a relevant Notion database when you need structured rows instead of free-form page text. Call notion_get_database_facts first when you need to filter or sort by property.",
      parameters: Type.Object({
        databaseId: Type.String({ description: "Notion database ID." }),
        pageSize: Type.Optional(Type.Number({ description: "Maximum number of rows to return." })),
        filterProperty: Type.Optional(Type.String({ description: "Optional property name to filter by." })),
        filterOperator: Type.Optional(Type.String({ description: "Optional filter operator: equals | contains | on_or_after | on_or_before." })),
        filterValue: Type.Optional(Type.String({ description: "Optional filter value, serialized as text." })),
        sortProperty: Type.Optional(Type.String({ description: "Optional property name to sort by." })),
        sortDirection: Type.Optional(Type.String({ description: "Optional sort direction: ascending | descending." })),
      }),
      async execute(_toolCallId, params, signal) {
        const result = await queryNotionDatabase(params as {
          databaseId: string;
          pageSize?: number;
          filterProperty?: string;
          filterOperator?: "equals" | "contains" | "on_or_after" | "on_or_before";
          filterValue?: string;
          sortProperty?: string;
          sortDirection?: "ascending" | "descending";
        }, env, signal);
        return {
          content: [{ type: "text", text: formatNotionDatabaseQueryText(result) }],
          details: result,
        };
      },
    },
  ];
}

function createSchedulerReadTools(config: AppConfig): ToolDefinition[] {
  const systemPaths = buildSystemPaths(config.workspaceDir);

  return [
    {
      name: "scheduler_list_schedules",
      label: "Scheduler List Schedules",
      description: "List unified scheduler facts across custom jobs and built-in schedules.",
      promptSnippet: "Use this when the user asks to list or inspect schedules from Slack.",
      parameters: Type.Object({
        channelId: Type.Optional(Type.String({ description: "Optional Slack channel ID filter. Defaults to the control room channel." })),
      }),
      async execute(_toolCallId, params) {
        const policy = await loadManagerPolicy(systemPaths);
        const schedules = await listUnifiedSchedules(systemPaths, policy, {
          channelId: (params as { channelId?: string }).channelId,
        });
        return {
          content: [{ type: "text", text: schedules.length > 0 ? schedules.map(formatScheduleViewText).join("\n\n") : "No schedules found." }],
          details: schedules,
        };
      },
    },
    {
      name: "scheduler_get_schedule",
      label: "Scheduler Get Schedule",
      description: "Get one unified scheduler fact by job ID or built-in schedule ID.",
      promptSnippet: "Use this when the user asks about one specific schedule like manager-review-evening or heartbeat.",
      parameters: Type.Object({
        id: Type.String({ description: "Custom job id or built-in schedule id such as manager-review-evening, morning-review, or heartbeat." }),
      }),
      async execute(_toolCallId, params) {
        const policy = await loadManagerPolicy(systemPaths);
        const schedule = await getUnifiedSchedule(systemPaths, policy, (params as { id: string }).id);
        return {
          content: [{ type: "text", text: schedule ? formatScheduleViewText(schedule) : "Schedule not found." }],
          details: schedule,
        };
      },
    },
  ];
}

function formatOwnerMapText(ownerMap: OwnerMap): string {
  const diagnostics = analyzeOwnerMap(ownerMap);
  return [
    "Owner map summary:",
    `- defaultOwner: ${ownerMap.defaultOwner}`,
    `- entries: ${ownerMap.entries.map((entry) => entry.id).join(", ") || "(none)"}`,
    `- duplicateSlackMappings: ${diagnostics.duplicateSlackUserIds.length > 0
      ? diagnostics.duplicateSlackUserIds
        .map((entry) => `${entry.slackUserId} -> ${entry.entryIds.join(", ")}`)
        .join(" | ")
      : "(none)"}`,
    `- unmappedEntries: ${diagnostics.unmappedSlackEntries.length > 0
      ? diagnostics.unmappedSlackEntries.map((entry) => entry.id).join(", ")
      : "(none)"}`,
    "",
    "Owner map JSON:",
    formatJsonDetails(ownerMap),
  ].join("\n");
}

function createWorkspaceReadTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "ownerMap">,
): ToolDefinition[] {
  const systemPaths = buildSystemPaths(config.workspaceDir);

  return [
    {
      name: "workspace_get_agenda_template",
      label: "Workspace Get Agenda Template",
      description: "Read the current AGENDA_TEMPLATE.md contents. Read-only.",
      promptSnippet: "Use this before proposing any AGENDA_TEMPLATE.md update or replacement so you can preserve the intended structure.",
      parameters: Type.Object({}),
      async execute() {
        const content = await readAgendaTemplate(systemPaths);
        return {
          content: [{ type: "text", text: content ?? "(empty agenda template)" }],
          details: { content: content ?? "" },
        };
      },
    },
    {
      name: "workspace_get_heartbeat_prompt",
      label: "Workspace Get HEARTBEAT Prompt",
      description: "Read the current HEARTBEAT.md contents. Read-only.",
      promptSnippet: "Use this before proposing any HEARTBEAT.md update or replacement so you inspect the current prompt first.",
      parameters: Type.Object({}),
      async execute() {
        const content = await readHeartbeatInstructions(systemPaths);
        return {
          content: [{ type: "text", text: content ?? "(empty heartbeat prompt)" }],
          details: { content: content ?? "" },
        };
      },
    },
    {
      name: "workspace_get_owner_map",
      label: "Workspace Get Owner Map",
      description: "Read owner-map.json with both raw JSON and duplicate or unmapped-entry diagnostics. Read-only.",
      promptSnippet: "Use this before proposing owner-map changes so you inspect the current default owner and entries first.",
      parameters: Type.Object({}),
      async execute() {
        const ownerMap = await repositories.ownerMap.load();
        const diagnostics = analyzeOwnerMap(ownerMap);
        return {
          content: [{ type: "text", text: formatOwnerMapText(ownerMap) }],
          details: {
            ownerMap,
            summary: {
              defaultOwner: ownerMap.defaultOwner,
              entryIds: ownerMap.entries.map((entry) => entry.id),
              duplicateSlackMappings: diagnostics.duplicateSlackUserIds,
              unmappedEntryIds: diagnostics.unmappedSlackEntries.map((entry) => entry.id),
            },
          },
        };
      },
    },
  ];
}

function createSlackContextTools(config: AppConfig): ToolDefinition[] {
  return [
    {
      name: "slack_get_thread_context",
      label: "Slack Get Thread Context",
      description: "Read the stored thread log for a Slack thread.",
      promptSnippet: "Use this for continuation, recent context, and response drafting.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Slack root thread timestamp." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of log entries." })),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as { channelId: string; threadTs: string; limit?: number };
        const context = await getSlackThreadContext(config.workspaceDir, typedParams.channelId, typedParams.threadTs, typedParams.limit);
        return {
          content: [{ type: "text", text: context.entries.length > 0 ? formatJsonDetails(context.entries) : "No stored thread context found." }],
          details: context,
        };
      },
    },
    {
      name: "slack_get_recent_channel_context",
      label: "Slack Get Recent Channel Context",
      description: "Read recent stored thread summaries for a Slack channel.",
      promptSnippet: "Use this sparingly when nearby channel context changes the answer.",
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of threads to inspect." })),
      }),
      async execute(_toolCallId, params) {
        const typedParams = params as { channelId: string; limit?: number };
        const contexts = await getRecentChannelContext(config.workspaceDir, typedParams.channelId, typedParams.limit);
        return {
          content: [{ type: "text", text: contexts.length > 0 ? formatJsonDetails(contexts) : "No recent channel context found." }],
          details: contexts,
        };
      },
    },
  ];
}

function createWebReadTools(): ToolDefinition[] {
  return [
    {
      name: "web_search_fetch",
      label: "Web Search Fetch",
      description: "Run a lightweight web search and return structured results.",
      promptSnippet: "Use this only when external research materially changes the answer.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { query: string; limit?: number };
        const results = await webSearchFetch(typedParams.query, typedParams.limit, signal);
        return {
          content: [{ type: "text", text: results.length > 0 ? formatJsonDetails(results) : "No web search results found." }],
          details: results,
        };
      },
    },
    {
      name: "web_fetch_url",
      label: "Web Fetch URL",
      description: "Fetch and summarize one URL.",
      promptSnippet: "Use this after selecting a relevant search result.",
      parameters: Type.Object({
        url: Type.String({ description: "URL to fetch." }),
      }),
      async execute(_toolCallId, params, signal) {
        const result = await webFetchUrl((params as { url: string }).url, signal);
        return {
          content: [{ type: "text", text: formatJsonDetails(result) }],
          details: result,
        };
      },
    },
  ];
}

function createProposalTools(): ToolDefinition[] {
  return [
    createProposalTool({
      name: "propose_create_issue",
      label: "Propose Create Issue",
      description: "Propose creating a single Linear issue. This does not execute the mutation.",
      promptSnippet: "Use this when the user clearly wants a single new tracked task.",
      commandType: "create_issue",
      parameters: Type.Object({
        planningReason: Type.Optional(Type.String({ description: "Usually single-issue." })),
        issue: Type.Object({
          title: Type.String({ description: "Issue title." }),
          description: Type.String({ description: "Markdown description." }),
          state: Type.Optional(Type.String({ description: "Optional initial state." })),
          dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD." })),
          assigneeMode: Type.String({ description: "assign | leave-unassigned. Decide explicitly whether to assign an owner." }),
          assignee: Type.Optional(Type.String({ description: "Assignee identifier. Required when assigneeMode=assign." })),
          parent: Type.Optional(Type.String({ description: "Optional parent issue identifier." })),
          priority: Type.Optional(Type.Number({ description: "Priority 1-4." })),
        }),
        threadParentHandling: Type.String({
          description: "ignore | attach. Decide explicitly whether this issue should become a child of the existing thread parent issue.",
        }),
        duplicateHandling: Type.String({
          description: "clarify | reuse-existing | reuse-and-attach-parent | create-new. Decide explicitly how to handle existing duplicate issues.",
        }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_create_issue_batch",
      label: "Propose Create Issue Batch",
      description: "Propose creating a parent issue plus child issues. This does not execute the mutation.",
      promptSnippet: "Use this when a request should be broken into a parent and execution-sized child tasks. Each batch may contain at most 8 children; split larger sets into multiple create_issue_batch proposals in the same turn.",
      commandType: "create_issue_batch",
      parameters: Type.Object({
        planningReason: Type.String({ description: "Usually complex-request or research-first." }),
        parent: Type.Object({
          title: Type.String({ description: "Parent issue title." }),
          description: Type.String({ description: "Parent issue description." }),
          state: Type.Optional(Type.String({ description: "Optional initial state." })),
          dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD." })),
          assigneeMode: Type.String({ description: "assign | leave-unassigned. Decide explicitly whether to assign the parent issue." }),
          assignee: Type.Optional(Type.String({ description: "Assignee identifier. Required when assigneeMode=assign." })),
          parent: Type.Optional(Type.String({ description: "Optional grandparent issue identifier." })),
          priority: Type.Optional(Type.Number({ description: "Priority 1-4." })),
        }),
        children: Type.Array(Type.Object({
          title: Type.String({ description: "Child issue title." }),
          description: Type.String({ description: "Child issue description." }),
          state: Type.Optional(Type.String({ description: "Optional initial state." })),
          dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD." })),
          assigneeMode: Type.String({ description: "assign | leave-unassigned. Decide explicitly whether to assign this child issue." }),
          assignee: Type.Optional(Type.String({ description: "Assignee identifier. Required when assigneeMode=assign." })),
          parent: Type.Optional(Type.String({ description: "Optional parent issue identifier override." })),
          priority: Type.Optional(Type.Number({ description: "Priority 1-4." })),
          kind: Type.Optional(Type.String({ description: "execution or research." })),
        })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_link_existing_issue",
      label: "Propose Link Existing Issue",
      description: "Propose using an existing Linear issue for one requested work item. This does not execute any Linear mutation.",
      promptSnippet: "Use this only after inspecting likely existing issues with linear_search_issues or linear_get_issue_facts and deciding one item should reuse an existing issue instead of creating a new one.",
      commandType: "link_existing_issue",
      parameters: Type.Object({
        issueId: Type.String({ description: "Existing issue identifier like AIC-123." }),
        reasonSummary: Type.String({ description: "Short reason for reusing this existing issue." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary from search results or issue facts." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_issue_status",
      label: "Propose Update Issue Status",
      description: "Propose a progress, completed, or blocked update. This does not execute the mutation.",
      promptSnippet: "Use this when the user reports progress, completion, or blocked status on an existing issue.",
      commandType: "update_issue_status",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        signal: Type.String({ description: "progress | completed | blocked" }),
        commentBody: Type.Optional(Type.String({ description: "Optional markdown body for the update." })),
        state: Type.Optional(Type.String({ description: "Optional target state name." })),
        dueDate: Type.Optional(Type.String({ description: "Optional due date in YYYY-MM-DD when the user states a new target completion date." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_assign_issue",
      label: "Propose Assign Issue",
      description: "Propose changing an issue assignee. This does not execute the mutation.",
      promptSnippet: "Use this when ownership should change.",
      commandType: "assign_issue",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        assignee: Type.String({ description: "Assignee display name, email, or username." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_add_comment",
      label: "Propose Add Comment",
      description: "Propose adding a markdown comment to an issue. This does not execute the mutation.",
      promptSnippet: "Use this when the right action is to record context on an issue without changing status.",
      commandType: "add_comment",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        body: Type.String({ description: "Markdown comment body." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_add_relation",
      label: "Propose Add Relation",
      description: "Propose adding a relation between issues. This does not execute the mutation.",
      promptSnippet: "Use this when a dependency should be made explicit.",
      commandType: "add_relation",
      parameters: Type.Object({
        issueId: Type.String({ description: "Source issue ID." }),
        relatedIssueId: Type.String({ description: "Related issue ID." }),
        relationType: Type.String({ description: "blocks or blocked-by." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_set_issue_parent",
      label: "Propose Set Issue Parent",
      description: "Propose making one issue a child of another issue. This does not execute the mutation.",
      promptSnippet: "Use this when the user explicitly asks to make AIC-123 a child task of AIC-456.",
      commandType: "set_issue_parent",
      parameters: Type.Object({
        issueId: Type.String({ description: "Child issue identifier like AIC-123." }),
        parentIssueId: Type.String({ description: "Parent issue identifier like AIC-456." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_create_scheduler_job",
      label: "Propose Create Scheduler Job",
      description: "Propose creating a custom scheduler job. This does not execute the mutation.",
      promptSnippet: "Use this when the user wants to add a new recurring or one-shot custom scheduler job from Slack.",
      commandType: "create_scheduler_job",
      parameters: Type.Object({
        jobId: Type.String({ description: "Stable custom job id such as daily-task-check." }),
        channelId: Type.Optional(Type.String({ description: "Optional target channel id. Omit to use the control room channel." })),
        prompt: Type.String({ description: "Prompt the scheduler job should execute." }),
        kind: Type.String({ description: "at | every | daily | weekly" }),
        at: Type.Optional(Type.String({ description: "ISO datetime for one-shot runs." })),
        everySec: Type.Optional(Type.Number({ description: "Interval seconds for kind=every." })),
        time: Type.Optional(Type.String({ description: "HH:MM for daily or weekly jobs." })),
        weekday: Type.Optional(Type.String({ description: "mon | tue | wed | thu | fri | sat | sun for weekly jobs." })),
        enabled: Type.Optional(Type.Boolean({ description: "Whether the custom job should start enabled." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_scheduler_job",
      label: "Propose Update Scheduler Job",
      description: "Propose updating a custom scheduler job. This does not execute the mutation.",
      promptSnippet: "Use this when the user wants to update, stop, resume, or retime a custom scheduler job.",
      commandType: "update_scheduler_job",
      parameters: Type.Object({
        jobId: Type.String({ description: "Existing custom job id." }),
        enabled: Type.Optional(Type.Boolean({ description: "Optional enabled flag." })),
        channelId: Type.Optional(Type.String({ description: "Optional channel id patch." })),
        prompt: Type.Optional(Type.String({ description: "Optional prompt patch." })),
        kind: Type.Optional(Type.String({ description: "Optional replacement schedule kind: at | every | daily | weekly." })),
        at: Type.Optional(Type.String({ description: "Optional ISO datetime patch for kind=at." })),
        everySec: Type.Optional(Type.Number({ description: "Optional seconds patch for kind=every." })),
        time: Type.Optional(Type.String({ description: "Optional HH:MM patch for daily or weekly jobs." })),
        weekday: Type.Optional(Type.String({ description: "Optional weekday patch for weekly jobs." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_delete_scheduler_job",
      label: "Propose Delete Scheduler Job",
      description: "Propose deleting a custom scheduler job. This does not execute the mutation.",
      promptSnippet: "Use this only for custom scheduler jobs. Built-in schedules should be disabled with propose_update_builtin_schedule instead.",
      commandType: "delete_scheduler_job",
      parameters: Type.Object({
        jobId: Type.String({ description: "Existing custom job id." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_builtin_schedule",
      label: "Propose Update Builtin Schedule",
      description: "Propose updating a built-in review or heartbeat schedule. This does not execute the mutation.",
      promptSnippet: "Use this for morning/evening/weekly review or heartbeat changes. Delete on a built-in means disable it instead of removing it.",
      commandType: "update_builtin_schedule",
      parameters: Type.Object({
        builtinId: Type.String({ description: "morning-review | evening-review | weekly-review | heartbeat" }),
        enabled: Type.Optional(Type.Boolean({ description: "Optional enable or disable flag." })),
        time: Type.Optional(Type.String({ description: "Optional HH:MM patch for review schedules." })),
        weekday: Type.Optional(Type.String({ description: "Optional weekday patch for weekly-review." })),
        intervalMin: Type.Optional(Type.Number({ description: "Optional heartbeat interval in minutes." })),
        activeLookbackHours: Type.Optional(Type.Number({ description: "Optional heartbeat active lookback window in hours." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_run_scheduler_job_now",
      label: "Propose Run Scheduler Job Now",
      description: "Propose running one custom scheduler job immediately. This does not execute the mutation.",
      promptSnippet: "Use this when the user asks to run a custom scheduler job immediately for testing or a one-off check.",
      commandType: "run_scheduler_job_now",
      parameters: Type.Object({
        jobId: Type.String({ description: "Existing custom scheduler job id." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_post_slack_message",
      label: "Propose Post Slack Message",
      description: "Propose posting one mention-tagged Slack message to the current thread or control room root. This does not execute the mutation.",
      promptSnippet: "Use this only for explicit Slack requests like X にメンションして Y と送って. Call workspace_get_owner_map first, resolve exactly one target, default to current-thread unless the user explicitly says control room, and do not include any extra mention tokens in messageText.",
      commandType: "post_slack_message",
      parameters: Type.Object({
        destination: Type.String({ description: "current-thread | control-room-root" }),
        mentionSlackUserId: Type.String({ description: "Resolved Slack user id from owner-map.json." }),
        targetLabel: Type.String({ description: "Human-readable target label such as y.kakui or kyaukyuai." }),
        messageText: Type.String({ description: "Final message body without the target mention token." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_workspace_memory",
      label: "Propose Update Workspace Memory",
      description: "Propose saving durable operator-specific knowledge into workspace MEMORY. This does not execute the mutation.",
      promptSnippet: "Use this only when the user explicitly asks to save durable facts, terminology, project context, members, roadmap milestones, or preferences into MEMORY.",
      commandType: "update_workspace_memory",
      parameters: Type.Object({
        sourceLabel: Type.Optional(Type.String({ description: "Optional short source label such as the Notion page title." })),
        entries: Type.Array(Type.Object({
          category: Type.String({ description: "One of project-overview | members-and-roles | roadmap-and-milestones | terminology | preferences | context. Legacy people-and-projects is accepted only for compatibility." }),
          projectName: Type.Optional(Type.String({ description: "Required for project-overview, members-and-roles, and roadmap-and-milestones." })),
          summary: Type.String({ description: "Short stable summary used for dedupe." }),
          canonicalText: Type.String({ description: "Stable MEMORY sentence to save." }),
        })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_replace_workspace_text_file",
      label: "Propose Replace Workspace Text File",
      description: "Propose updating AGENDA_TEMPLATE.md or HEARTBEAT.md by replacing the full file contents. This does not execute the mutation.",
      promptSnippet: "Use this for explicit Slack requests to update or replace the whole agenda template or heartbeat prompt. Read the current file first with the matching workspace_get tool. Do not say that file editing is unavailable.",
      commandType: "replace_workspace_text_file",
      parameters: Type.Object({
        target: Type.String({ description: "agenda-template | heartbeat-prompt" }),
        content: Type.String({ description: "Final full file content after replacement." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_owner_map",
      label: "Propose Update Owner Map",
      description: "Propose a structured owner-map.json change. This does not execute the mutation.",
      promptSnippet: "Use this only for explicit Slack requests to update owner-map.json. Call workspace_get_owner_map first and propose one structured operation at a time. Do not say that file editing is unavailable.",
      commandType: "update_owner_map",
      parameters: Type.Object({
        operation: Type.String({ description: "set-default-owner | upsert-entry | delete-entry" }),
        entryId: Type.Optional(Type.String({ description: "Target entry id. Required for upsert-entry and delete-entry." })),
        defaultOwner: Type.Optional(Type.String({ description: "New default owner. Required for set-default-owner." })),
        linearAssignee: Type.Optional(Type.String({ description: "Linear assignee label. Required for upsert-entry." })),
        slackUserId: Type.Optional(Type.String({ description: "Optional Slack user id for upsert-entry." })),
        domains: Type.Optional(Type.Array(Type.String({ description: "Optional domains for upsert-entry." }))),
        keywords: Type.Optional(Type.Array(Type.String({ description: "Optional keywords for upsert-entry." }))),
        primary: Type.Optional(Type.Boolean({ description: "Optional primary flag for upsert-entry." })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_create_notion_agenda",
      label: "Propose Create Notion Agenda",
      description: "Propose creating a Notion agenda page. This does not execute the mutation.",
      promptSnippet: "Use this when the user explicitly asks to create an agenda in Notion.",
      commandType: "create_notion_agenda",
      parameters: Type.Object({
        title: Type.String({ description: "Agenda page title." }),
        summary: Type.Optional(Type.String({ description: "Optional short summary or purpose shown near the top of the page." })),
        parentPageId: Type.Optional(Type.String({ description: "Optional Notion parent page ID. Omit this to use the configured default agenda parent." })),
        sections: Type.Optional(Type.Array(Type.Object({
          heading: Type.String({ description: "Section heading such as 目的 or 議題." }),
          paragraph: Type.Optional(Type.String({ description: "Optional paragraph body for the section." })),
          bullets: Type.Optional(Type.Array(Type.String({ description: "Optional bullet items for the section." }))),
        }))),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_update_notion_page",
      label: "Propose Update Notion Page",
      description: "Propose updating one existing Notion page. This does not execute the mutation.",
      promptSnippet: "Use this when the user asks to update a Notion page, retitle it, append notes, or replace one named section on a Cogito-managed page.",
      commandType: "update_notion_page",
      parameters: Type.Object({
        pageId: Type.String({ description: "Target Notion page ID." }),
        mode: Type.String({ description: "append | replace_section" }),
        title: Type.Optional(Type.String({ description: "Optional new page title." })),
        summary: Type.Optional(Type.String({ description: "Optional summary paragraph to append near the end of the page." })),
        sections: Type.Optional(Type.Array(Type.Object({
          heading: Type.String({ description: "Section heading such as 決定事項 or 次のアクション." }),
          paragraph: Type.Optional(Type.String({ description: "Optional paragraph body for the section." })),
          bullets: Type.Optional(Type.Array(Type.String({ description: "Optional bullet items for the section." }))),
        }))),
        sectionHeading: Type.Optional(Type.String({ description: "Required for replace_section. Exact top-level heading_2 label to replace, such as 議題 or 次のアクション." })),
        paragraph: Type.Optional(Type.String({ description: "Optional replacement paragraph for replace_section." })),
        bullets: Type.Optional(Type.Array(Type.String({ description: "Optional replacement bullet items for replace_section." }))),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_archive_notion_page",
      label: "Propose Archive Notion Page",
      description: "Propose archiving one existing Notion page. This does not execute the mutation.",
      promptSnippet: "Use this when the user asks to delete, archive, or trash a Notion page. In this scope, delete means archive/trash.",
      commandType: "archive_notion_page",
      parameters: Type.Object({
        pageId: Type.String({ description: "Target Notion page ID." }),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_followup_resolution",
      label: "Propose Followup Resolution",
      description: "Propose resolving an outstanding follow-up. This does not execute the mutation.",
      promptSnippet: "Use this when a thread reply answers a follow-up request.",
      commandType: "resolve_followup",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        answered: Type.Boolean({ description: "Whether the follow-up is sufficiently answered." }),
        confidence: Type.Number({ description: "Confidence between 0 and 1." }),
        answerKind: Type.Optional(Type.String({ description: "Short answer kind label." })),
        requestKind: Type.Optional(Type.String({ description: "status | blocked-details | owner | due-date" })),
        responseText: Type.String({ description: "User response text." }),
        acceptableAnswerHint: Type.Optional(Type.String({ description: "Preferred answer format hint." })),
        extractedFields: Type.Optional(Type.Object({}, { additionalProperties: Type.String() })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
    createProposalTool({
      name: "propose_review_followup",
      label: "Propose Review Followup",
      description: "Propose a proactive follow-up request for review or heartbeat. This does not execute the mutation.",
      promptSnippet: "Use this when a review should ask for one concrete follow-up.",
      commandType: "review_followup",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        issueTitle: Type.String({ description: "Issue title." }),
        riskCategory: Type.String({ description: "Primary risk category." }),
        requestKind: Type.String({ description: "status | blocked-details | owner | due-date" }),
        request: Type.String({ description: "Follow-up request text." }),
        acceptableAnswerHint: Type.Optional(Type.String({ description: "Preferred answer format." })),
        assigneeDisplayName: Type.Optional(Type.String({ description: "Assignee display name." })),
        slackUserId: Type.Optional(Type.String({ description: "Slack user ID if known." })),
        source: Type.Optional(Type.Object({
          channelId: Type.String({ description: "Source channel ID." }),
          rootThreadTs: Type.String({ description: "Source thread timestamp." }),
          sourceMessageTs: Type.String({ description: "Source message timestamp." }),
        })),
        reasonSummary: Type.String({ description: "Short reason for this proposal." }),
        evidenceSummary: Type.Optional(Type.String({ description: "Short evidence summary." })),
        dedupeKeyCandidate: Type.Optional(Type.String({ description: "Stable dedupe key when you can infer one." })),
      }),
    }),
  ];
}

export function createManagerAgentTools(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "policy" | "workgraph" | "ownerMap">,
): ToolDefinition[] {
  return [
    createIntentReportTool(),
    createPendingClarificationDecisionTool(),
    createTaskExecutionDecisionTool(),
    createQuerySnapshotTool(),
    ...createLinearReadTools(config),
    ...createSchedulerReadTools(config),
    ...createWorkspaceReadTools(config, repositories),
    ...createNotionReadTools(config),
    ...createSlackContextTools(config),
    ...createWorkgraphReadTools(repositories),
    ...createWebReadTools(),
    ...createProposalTools(),
  ];
}
