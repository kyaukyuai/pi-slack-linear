import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import {
  addLinearComment,
  addLinearRelation,
  assignLinearIssue,
  createManagedLinearIssue,
  getLinearIssue,
  listLinearTeamMembers,
  listRiskyLinearIssues,
  createLinearIssue,
  listActiveLinearIssues,
  searchLinearIssues,
  updateLinearIssue,
  updateManagedLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
  type LinearIssueResult,
  type LinearListResult,
} from "./linear.js";
import { loadManagerPolicy } from "./manager-state.js";
import { buildSystemPaths } from "./system-workspace.js";

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
      description: "Search active Linear issues in the fixed team by title.",
      promptSnippet: "Search existing issues before creating duplicates.",
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
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        const policy = await loadManagerPolicy(systemPaths);
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
  ];
}
