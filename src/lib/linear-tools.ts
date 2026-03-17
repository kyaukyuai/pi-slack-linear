import { Type } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AppConfig } from "./config.js";
import {
  createLinearIssue,
  listActiveLinearIssues,
  updateLinearIssueState,
  type LinearCommandEnv,
  type LinearIssueResult,
  type LinearListResult,
} from "./linear.js";

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
  const lines = [`Linear issue moved to ${state}.`];

  if (result.issueId) lines.push(`ID: ${result.issueId}`);
  if (result.url) lines.push(`URL: ${result.url}`);
  if (result.output) lines.push(`CLI output: ${result.output}`);

  return lines.join("\n");
}

export function createLinearCustomTools(config: AppConfig): ToolDefinition[] {
  const env = buildLinearEnv(config);

  return [
    {
      name: "linear_create_issue",
      label: "Linear Create Issue",
      description: "Create a Linear issue in the fixed workspace and fixed team for an explicit task request.",
      promptSnippet: "Create a Linear issue in the fixed team.",
      promptGuidelines: [
        "Use this when the user explicitly asks to add or create a tracked task.",
        "Provide a concise title and a short markdown description that captures the Slack context.",
        "Do not ask the user for API keys or workspace/team identifiers.",
      ],
      parameters: Type.Object({
        title: Type.String({ description: "A concise Linear issue title." }),
        description: Type.String({ description: "A short markdown description for the issue." }),
        state: Type.Optional(Type.String({ description: "Optional initial issue state, such as backlog or started." })),
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
      name: "linear_update_issue_state",
      label: "Linear Update Issue State",
      description: "Move a Linear issue to a new state, such as started or completed.",
      promptSnippet: "Update the state of an existing Linear issue.",
      promptGuidelines: [
        "Use this when the user wants to complete, start, or otherwise move an existing tracked task.",
        "If the issue ID is ambiguous, inspect active issues first and ask one concise follow-up question.",
      ],
      parameters: Type.Object({
        issueId: Type.String({ description: "Issue ID like AIC-123." }),
        state: Type.String({ description: "Target workflow state type or name, such as completed or started." }),
      }),
      async execute(_toolCallId, params, signal) {
        const typedParams = params as Parameters<typeof updateLinearIssueState>[0];
        const result = await updateLinearIssueState(typedParams, env, signal);
        return {
          content: [{ type: "text", text: formatUpdateIssueStateResult(result, typedParams.state) }],
          details: result,
        };
      },
    },
  ];
}
