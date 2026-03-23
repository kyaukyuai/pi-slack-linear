import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  getLinearIssue,
  listOpenLinearIssues,
  listLinearTeamMembers,
  searchLinearIssues,
  type LinearIssue,
  type LinearCommandEnv,
} from "./linear.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import { webFetchUrl, webSearchFetch } from "./web-research.js";
import { createWorkgraphReadTools } from "./workgraph-tools.js";
import {
  managerCommandProposalSchema,
  type ManagerCommandProposal,
  type ManagerIntentReport,
} from "./manager-command-commit.js";

function buildLinearEnv(config: AppConfig): LinearCommandEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
}

function formatJsonDetails(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatIssue(issue: { identifier: string; title: string; url?: string | null }): string {
  return issue.url ? `${issue.identifier} ${issue.title}\n${issue.url}` : `${issue.identifier} ${issue.title}`;
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

function overdueDays(dueDate: string | null | undefined, right = new Date()): number | undefined {
  if (!dueDate) return undefined;
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return undefined;
  const today = new Date(Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate()));
  const diffMs = today.getTime() - due.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function buildIssueFacts(issue: LinearIssue): Record<string, unknown> {
  const blockedState = issue.state?.name?.toLowerCase() === "blocked";
  const blockedByDependency = (issue.inverseRelations ?? []).some((relation) => relation.type === "blocked-by");
  const recentBlockedUpdate = issue.latestActionKind === "blocked";
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    description: issue.description ?? undefined,
    state: issue.state ?? undefined,
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
    staleBusinessDays: businessDaysSince(issue.updatedAt),
    ownerMissing: !issue.assignee,
    dueMissing: !issue.dueDate,
    blockedSignals: {
      blockedState,
      blockedByDependency,
      recentBlockedUpdate,
    },
  };
}

function createIntentReportTool(): ToolDefinition {
  return {
    name: "report_manager_intent",
    label: "Report Manager Intent",
    description: "Record the current high-level intent before or during tool usage. Use this once per turn.",
    promptSnippet: "Call this early to tell the manager what kind of turn this is.",
    parameters: Type.Object({
      intent: Type.String({ description: "conversation | query | create_work | update_progress | update_completed | update_blocked | followup_resolution | review | heartbeat | scheduler" }),
      queryKind: Type.Optional(Type.String({ description: "Optional query subtype." })),
      queryScope: Type.Optional(Type.String({ description: "Optional query scope self | team | thread-context." })),
      confidence: Type.Optional(Type.Number({ description: "Confidence between 0 and 1." })),
      summary: Type.Optional(Type.String({ description: "One short sentence explaining the intent." })),
    }),
    async execute(_toolCallId, params) {
      const typed = params as ManagerIntentReport;
      return {
        content: [{ type: "text", text: "Intent recorded." }],
        details: { intentReport: typed },
      };
    },
  };
}

function createQuerySnapshotTool(): ToolDefinition {
  return {
    name: "report_query_snapshot",
    label: "Report Query Snapshot",
    description: "Record which issue IDs were shown in a query reply and which relevant issue IDs remain for continuation.",
    promptSnippet: "Use this once for list/prioritize/search/inspect/next-step query replies when issue IDs are available.",
    parameters: Type.Object({
      issueIds: Type.Optional(Type.Array(Type.String({ description: "Issue IDs explicitly shown in this reply." }))),
      shownIssueIds: Type.Optional(Type.Array(Type.String({ description: "All issue IDs already shown in this query chain, including this reply." }))),
      remainingIssueIds: Type.Optional(Type.Array(Type.String({ description: "Relevant issue IDs not yet shown but still candidates for a follow-up like 他には?" }))),
      totalItemCount: Type.Optional(Type.Number({ description: "Total number of relevant issues in this query result set." })),
      replySummary: Type.Optional(Type.String({ description: "One short sentence summarizing the reply." })),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Query snapshot recorded." }],
        details: { querySnapshot: params as Record<string, unknown> },
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
      promptSnippet: "Use this for review, heartbeat, and next-step suggestions. Select the important issues yourself from the facts.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of issues to fetch." })),
      }),
      async execute(_toolCallId, _params, signal) {
        const issues = await listOpenLinearIssues(env, signal);
        return {
          content: [{ type: "text", text: issues.length > 0 ? formatJsonDetails(issues.slice(0, (_params as { limit?: number } | undefined)?.limit ?? 50).map((issue) => buildIssueFacts(issue))) : "No review facts found." }],
          details: issues.slice(0, (_params as { limit?: number } | undefined)?.limit ?? 50).map((issue) => buildIssueFacts(issue)),
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
      promptSnippet: "Use this when a request should be broken into a parent and execution-sized child tasks.",
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
  repositories: Pick<ManagerRepositories, "policy" | "workgraph">,
): ToolDefinition[] {
  return [
    createIntentReportTool(),
    createQuerySnapshotTool(),
    ...createLinearReadTools(config),
    ...createSlackContextTools(config),
    ...createWorkgraphReadTools(repositories),
    ...createWebReadTools(),
    ...createProposalTools(),
  ];
}
