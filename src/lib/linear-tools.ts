import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import {
  addLinearComment,
  addLinearProgressComment,
  addLinearRelation,
  assignLinearIssue,
  createManagedLinearIssue,
  getLinearIssue,
  listLinearTeamMembers,
  listRiskyLinearIssues,
  markLinearIssueBlocked,
  createLinearIssue,
  listActiveLinearIssues,
  searchLinearIssues,
  updateLinearIssue,
  updateLinearIssueState,
  updateManagedLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
  type LinearIssueResult,
  type LinearListResult,
} from "./linear.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import { buildSystemPaths } from "./system-workspace.js";
import { webFetchUrl, webSearchFetch } from "./web-research.js";
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";

function buildLinearEnv(config: AppConfig): LinearCommandEnv {
  return {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
}

function formatCreateIssueResult(result: LinearIssueResult): string {
  const lines = ["Linear issue created."];

  if (result.issueId) lines.push(`ID: ${result.issueId}`);
  if (result.title) lines.push(`Title: ${result.title}`);
  if (result.url) lines.push(`URL: ${result.url}`);

  if (!result.issueId) {
    lines.push(`CLI output: ${result.output || "(empty)"}`);
  }

  return lines.join("\n");
}

function formatListIssuesResult(result: LinearListResult): string {
  return `Active Linear issues:\n${result.output || "(no active issues found)"}`;
}

function formatUpdateIssueStateResult(result: LinearIssueResult, state: string): string {
  const lines = [state ? `Linear issue updated (${state}).` : "Linear issue updated."];

  if (result.issueId) lines.push(`ID: ${result.issueId}`);
  if (result.url) lines.push(`URL: ${result.url}`);
  if (result.output) lines.push(`CLI output: ${result.output}`);

  return lines.join("\n");
}

function formatManagedIssue(issue: LinearIssue, prefix: string): string {
  const lines = [`${prefix}`];
  lines.push(`ID: ${issue.identifier}`);
  lines.push(`Title: ${issue.title}`);
  if (issue.parent?.identifier) lines.push(`Parent: ${issue.parent.identifier}`);
  if (issue.assignee?.displayName || issue.assignee?.name) {
    lines.push(`Assignee: ${issue.assignee.displayName ?? issue.assignee.name}`);
  }
  if (issue.dueDate) lines.push(`Due: ${issue.dueDate}`);
  if (issue.url) lines.push(`URL: ${issue.url}`);
  return lines.join("\n");
}

export function createLinearCustomTools(config: AppConfig): ToolDefinition[] {
  const env = buildLinearEnv(config);
  const systemPaths = buildSystemPaths(config.workspaceDir);
  const managerRepositories = createFileBackedManagerRepositories(systemPaths);

  return [
    {
      name: "linear_create_issue",
      label: "Linear Create Issue",
      description: "Create a Linear issue in the fixed workspace and fixed team for an explicit task request.",
      promptSnippet: "Create a Linear issue in the fixed team.",
      promptGuidelines: [
        "Use this when the user explicitly asks to add or create a tracked task.",
        "Provide a concise title and a short markdown description that captures the Slack context.",
        "If the user specifies a due date, convert it to YYYY-MM-DD in Asia/Tokyo and pass it as dueDate.",
        "Do not ask the user for API keys or workspace/team identifiers.",
      ],
      parameters: Type.Object({
        title: Type.String({ description: "A concise Linear issue title." }),
        description: Type.String({ description: "A short markdown description for the issue." }),
        state: Type.Optional(Type.String({ description: "Optional initial issue state, such as backlog or started." })),
        dueDate: Type.Optional(Type.String({ description: "Optional due date in YYYY-MM-DD format." })),
      }),
      async execute(_toolCallId, params, signal) {
        const result = await createLinearIssue(params as Parameters<typeof createLinearIssue>[0], env, signal);
        return {
          content: [{ type: "text", text: formatCreateIssueResult(result) }],
          details: result,
        };
      },
    },
    {
      name: "linear_list_active_issues",
      label: "Linear List Active Issues",
      description: "List active Linear issues in the fixed workspace and fixed team.",
      promptSnippet: "List active Linear issues in the fixed team.",
      promptGuidelines: [
        "Use this for requests like タスク確認, タスク一覧, active issues, or what is still open.",
        "Keep the limit modest unless the user explicitly asks for more.",
      ],
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Maximum number of issues to fetch. Defaults to 20." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { limit?: number };
        const result = await listActiveLinearIssues(typedParams.limit ?? 20, env, signal);
        return {
          content: [{ type: "text", text: formatListIssuesResult(result) }],
          details: result,
        };
      },
    },
    {
      name: "linear_search_issues",
      label: "Linear Search Issues",
      description: "Search active Linear issues in the fixed team before creating a new issue or attaching research work.",
      promptSnippet: "Search existing issues before creating duplicates or choosing a parent issue.",
      promptGuidelines: [
        "Use this before creating tracked work.",
        "Use this for research requests too, so existing parent issues can be reused.",
        "Prefer reusing an existing thread-linked or duplicate issue over creating a new one.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        states: Type.Optional(Type.Array(Type.String({ description: "Optional state type filters." }))),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { query: string; states?: string[]; limit?: number };
        const issues = await searchLinearIssues(typedParams, env, signal);
        const text = issues.length > 0
          ? issues.map((issue) => formatManagedIssue(issue, "Linear issue found.")).join("\n\n")
          : "No matching active Linear issues found.";
        return {
          content: [{ type: "text", text }],
          details: issues,
        };
      },
    },
    {
      name: "linear_get_issue",
      label: "Linear Get Issue",
      description: "Load a Linear issue with parent, children, and relations.",
      promptSnippet: "Inspect the issue before updating it.",
      promptGuidelines: [
        "Use this before status updates when the thread may contain multiple parent and child issues.",
        "Use this to confirm parent-child structure before attaching new child work.",
      ],
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
      }),
      async execute(_toolCallId, params, signal) {
        const issue = await getLinearIssue((params as { issueId: string }).issueId, env, signal);
        return {
          content: [{ type: "text", text: formatManagedIssue(issue, "Linear issue loaded.") }],
          details: issue,
        };
      },
    },
    {
      name: "linear_create_parent_issue",
      label: "Linear Create Parent Issue",
      description: "Create a parent Linear issue for a larger request.",
      promptSnippet: "Create a parent issue when a request should be broken into sub-tasks.",
      parameters: Type.Object({
        title: Type.String({ description: "Parent issue title." }),
        description: Type.String({ description: "Markdown description." }),
        dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD." })),
        priority: Type.Optional(Type.Number({ description: "Priority 1-4." })),
      }),
      async execute(_toolCallId, params, signal) {
        const issue = await createManagedLinearIssue(params as Parameters<typeof createManagedLinearIssue>[0], env, signal);
        return {
          content: [{ type: "text", text: formatManagedIssue(issue, "Parent issue created.") }],
          details: issue,
        };
      },
    },
    {
      name: "linear_create_child_issue",
      label: "Linear Create Child Issue",
      description: "Create a child Linear issue under a parent issue.",
      promptSnippet: "Create execution-sized child issues under a parent issue.",
      parameters: Type.Object({
        parent: Type.String({ description: "Parent issue identifier like AIC-123." }),
        title: Type.String({ description: "Child issue title." }),
        description: Type.String({ description: "Markdown description." }),
        assignee: Type.Optional(Type.String({ description: "Assignee display name, email, or username." })),
        dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD." })),
        priority: Type.Optional(Type.Number({ description: "Priority 1-4." })),
      }),
      async execute(_toolCallId, params, signal) {
        const issue = await createManagedLinearIssue(params as Parameters<typeof createManagedLinearIssue>[0], env, signal);
        return {
          content: [{ type: "text", text: formatManagedIssue(issue, "Child issue created.") }],
          details: issue,
        };
      },
    },
    {
      name: "linear_assign_issue",
      label: "Linear Assign Issue",
      description: "Assign an issue to a team member.",
      promptSnippet: "Assign the issue according to the owner map.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        assignee: Type.String({ description: "Assignee display name, email, or username." }),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { issueId: string; assignee: string };
        const issue = await assignLinearIssue(typedParams.issueId, typedParams.assignee, env, signal);
        return {
          content: [{ type: "text", text: formatManagedIssue(issue, "Issue assigned.") }],
          details: issue,
        };
      },
    },
    {
      name: "linear_add_comment",
      label: "Linear Add Comment",
      description: "Add a markdown comment to a Linear issue.",
      promptSnippet: "Record research findings or Slack context on the issue.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        body: Type.String({ description: "Markdown comment body." }),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { issueId: string; body: string };
        const comment = await addLinearComment(typedParams.issueId, typedParams.body, env, signal);
        return {
          content: [{ type: "text", text: `Comment added.\nID: ${comment.id}${comment.url ? `\nURL: ${comment.url}` : ""}` }],
          details: comment,
        };
      },
    },
    {
      name: "linear_add_relation",
      label: "Linear Add Relation",
      description: "Add a blocks or blocked-by relation between two issues.",
      promptSnippet: "Use this when task dependencies should be made explicit.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Source issue identifier like AIC-123." }),
        relationType: Type.String({ description: "blocks or blocked-by." }),
        relatedIssueId: Type.String({ description: "Related issue identifier like AIC-124." }),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { issueId: string; relationType: "blocks" | "blocked-by"; relatedIssueId: string };
        await addLinearRelation(typedParams.issueId, typedParams.relationType, typedParams.relatedIssueId, env, signal);
        return {
          content: [{ type: "text", text: `Relation created.\n${typedParams.issueId} ${typedParams.relationType} ${typedParams.relatedIssueId}` }],
          details: typedParams,
        };
      },
    },
    {
      name: "linear_list_risky_issues",
      label: "Linear List Risky Issues",
      description: "List issues that are overdue, stale, blocked, or missing owner/due date according to policy.",
      promptSnippet: "Use this for reviews, follow-ups, and progress checks.",
      promptGuidelines: [
        "Use this for reviews, heartbeat-style follow-ups, and progress checks.",
        "Treat blocked as blocked state or blocked-by dependency; do not treat plain outgoing blocks relations as blocked.",
      ],
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        const policy = await managerRepositories.policy.load();
        const issues = await listRiskyLinearIssues(
          {
            staleBusinessDays: policy.staleBusinessDays,
            urgentPriorityThreshold: policy.urgentPriorityThreshold,
          },
          env,
          signal,
        );
        const text = issues.length > 0
          ? issues.map((issue) => formatManagedIssue(issue, "Risk candidate.")).join("\n\n")
          : "No risky issues found.";
        return {
          content: [{ type: "text", text }],
          details: issues,
        };
      },
    },
    {
      name: "linear_list_team_members",
      label: "Linear List Team Members",
      description: "List active Linear users for owner assignment.",
      promptSnippet: "Resolve assignees before assigning work.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        const users = await listLinearTeamMembers(env, signal);
        const text = users.length > 0
          ? users.map((user) => `- ${user.displayName ?? user.name ?? user.email ?? user.id}`).join("\n")
          : "No active users found.";
        return {
          content: [{ type: "text", text }],
          details: users,
        };
      },
    },
    {
      name: "linear_update_issue",
      label: "Linear Update Issue",
      description: "Update an existing Linear issue, including state and due date.",
      promptSnippet: "Update the state or due date of an existing Linear issue.",
      promptGuidelines: [
        "Use this when the user wants to complete, start, reschedule, or otherwise update an existing tracked task.",
        "Convert relative dates like 明日 or 来週金曜 to YYYY-MM-DD in Asia/Tokyo.",
        "If the issue ID is ambiguous, inspect active issues first and ask one concise follow-up question.",
      ],
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue ID like AIC-123." }),
        state: Type.Optional(Type.String({ description: "Target workflow state type or name, such as completed or started." })),
        dueDate: Type.Optional(Type.String({ description: "New due date in YYYY-MM-DD format." })),
        clearDueDate: Type.Optional(Type.Boolean({ description: "Set true to remove the current due date." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as Parameters<typeof updateLinearIssue>[0];
        const result = await updateLinearIssue(typedParams, env, signal);
        return {
          content: [{ type: "text", text: formatUpdateIssueStateResult(result, typedParams.state ?? "updated") }],
          details: result,
        };
      },
    },
    {
      name: "linear_update_issue_metadata",
      label: "Linear Update Issue Metadata",
      description: "Update issue metadata such as title, description, parent, assignee, due date, priority, or state.",
      promptSnippet: "Use this for controlled metadata updates on existing issues.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        title: Type.Optional(Type.String({ description: "Updated title." })),
        description: Type.Optional(Type.String({ description: "Updated markdown description." })),
        state: Type.Optional(Type.String({ description: "Workflow state name or type." })),
        assignee: Type.Optional(Type.String({ description: "Assignee display name, email, or username." })),
        dueDate: Type.Optional(Type.String({ description: "New due date in YYYY-MM-DD format." })),
        clearDueDate: Type.Optional(Type.Boolean({ description: "Set true to remove due date." })),
        priority: Type.Optional(Type.Number({ description: "Priority 1-4." })),
        parent: Type.Optional(Type.String({ description: "New parent issue identifier." })),
      }),
      async execute(_toolCallId, params, signal) {
        const issue = await updateManagedLinearIssue(params as Parameters<typeof updateManagedLinearIssue>[0], env, signal);
        return {
          content: [{ type: "text", text: formatManagedIssue(issue, "Issue metadata updated.") }],
          details: issue,
        };
      },
    },
    {
      name: "linear_update_issue_state",
      label: "Linear Update Issue State",
      description: "Update only the workflow state of an issue.",
      promptSnippet: "Use this for explicit completion or status changes.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        state: Type.String({ description: "Target workflow state type or name." }),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { issueId: string; state: string };
        const issue = await updateLinearIssueState(typedParams.issueId, typedParams.state, env, signal);
        return {
          content: [{ type: "text", text: formatManagedIssue(issue, "Issue state updated.") }],
          details: issue,
        };
      },
    },
    {
      name: "linear_add_progress_comment",
      label: "Linear Add Progress Comment",
      description: "Add a progress update comment to a Linear issue.",
      promptSnippet: "Use this when the user reports progress in an existing thread.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        body: Type.String({ description: "Progress update markdown body." }),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { issueId: string; body: string };
        const comment = await addLinearProgressComment(typedParams.issueId, typedParams.body, env, signal);
        return {
          content: [{ type: "text", text: `Progress comment added.\nID: ${comment.id}${comment.url ? `\nURL: ${comment.url}` : ""}` }],
          details: comment,
        };
      },
    },
    {
      name: "linear_mark_blocked",
      label: "Linear Mark Blocked",
      description: "Add a blocked update comment and attempt to move the issue into a blocked state.",
      promptSnippet: "Use this when the user explicitly says the work is blocked.",
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue identifier like AIC-123." }),
        body: Type.String({ description: "Blocked update markdown body." }),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { issueId: string; body: string };
        const result = await markLinearIssueBlocked(typedParams.issueId, typedParams.body, env, signal);
        return {
          content: [{
            type: "text",
            text: `${formatManagedIssue(result.issue, "Issue marked blocked.")}${result.blockedStateApplied ? "" : "\nBlocked state was not found; only a comment was added."}`,
          }],
          details: result,
        };
      },
    },
    {
      name: "slack_get_thread_context",
      label: "Slack Get Thread Context",
      description: "Read the recent stored message log for a Slack thread in the local workspace.",
      promptSnippet: "Use this before researching or summarizing a thread.",
      promptGuidelines: [
        "Use this before research or planning, not for every message.",
        "Prefer this when Slack context may change issue scope or next actions.",
      ],
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        threadTs: Type.String({ description: "Root thread timestamp." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of log entries to return." })),
      }),
      async execute(_toolCallId, params, _signal) {
        const typedParams = params as { channelId: string; threadTs: string; limit?: number };
        const context = await getSlackThreadContext(config.workspaceDir, typedParams.channelId, typedParams.threadTs, typedParams.limit);
        const text = context.entries.length > 0
          ? context.entries.map((entry) => `- [${entry.type}] ${entry.text}`).join("\n")
          : "No stored thread context found.";
        return {
          content: [{ type: "text", text }],
          details: context,
        };
      },
    },
    {
      name: "slack_get_recent_channel_context",
      label: "Slack Get Recent Channel Context",
      description: "Read recent stored thread summaries for an allowed channel.",
      promptSnippet: "Use this to understand nearby work before planning or researching.",
      promptGuidelines: [
        "Use this only when nearby work may affect research or planning.",
        "Do not read broad channel context unless it materially changes the next task decision.",
      ],
      parameters: Type.Object({
        channelId: Type.String({ description: "Slack channel ID." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of recent threads to inspect." })),
      }),
      async execute(_toolCallId, params, _signal) {
        const typedParams = params as { channelId: string; limit?: number };
        const contexts = await getRecentChannelContext(config.workspaceDir, typedParams.channelId, typedParams.limit);
        const text = contexts.length > 0
          ? contexts.map((context) => `- ${context.rootThreadTs}: ${context.entries.slice(-1)[0]?.text ?? "(no entries)"}`).join("\n")
          : "No recent thread context found.";
        return {
          content: [{ type: "text", text }],
          details: contexts,
        };
      },
    },
    {
      name: "web_search_fetch",
      label: "Web Search Fetch",
      description: "Run a lightweight web search and return structured results.",
      promptSnippet: "Use this for lightweight research without external search API keys.",
      promptGuidelines: [
        "Use this only when research is required.",
        "Keep the search narrow and inspect only a small number of top results.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of search results." })),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as { query: string; limit?: number };
        const results = await webSearchFetch(typedParams.query, typedParams.limit, signal);
        const text = results.length > 0
          ? results.map((result) => `- ${result.title}\n  - ${result.url}\n  - ${result.snippet ?? ""}`.trim()).join("\n")
          : "No search results found.";
        return {
          content: [{ type: "text", text }],
          details: results,
        };
      },
    },
    {
      name: "web_fetch_url",
      label: "Web Fetch URL",
      description: "Fetch a web page and return a short summary.",
      promptSnippet: "Use this after web_search_fetch when one result needs a closer read.",
      promptGuidelines: [
        "Use this only after web_search_fetch identifies a promising result.",
        "Fetch only the small number of pages needed to support the research summary.",
      ],
      parameters: Type.Object({
        url: Type.String({ description: "URL to fetch." }),
      }),
      async execute(_toolCallId, params, signal) {
        const summary = await webFetchUrl((params as { url: string }).url, signal);
        return {
          content: [{ type: "text", text: `Title: ${summary.title ?? "(none)"}\nURL: ${summary.url}\nSnippet: ${summary.snippet ?? "(none)"}` }],
          details: summary,
        };
      },
    },
  ];
}
