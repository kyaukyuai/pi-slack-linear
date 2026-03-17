import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LinearCommandEnv {
  LINEAR_API_KEY?: string;
  LINEAR_WORKSPACE?: string;
  LINEAR_TEAM_KEY?: string;
  [key: string]: string | undefined;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  state?: string;
  dueDate?: string;
}

export interface LinearIssueResult {
  issueId?: string;
  title?: string;
  url?: string;
  output: string;
}

export interface LinearListResult {
  output: string;
}

export interface UpdateIssueInput {
  issueId: string;
  state?: string;
  dueDate?: string;
  clearDueDate?: boolean;
}

export interface LinearUser {
  id: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
  description?: string | null;
  dueDate?: string | null;
  priority?: number | null;
  updatedAt?: string | null;
  assignee?: LinearUser | null;
  state?: LinearWorkflowState | null;
  parent?: Pick<LinearIssue, "id" | "identifier" | "title" | "url"> | null;
  children?: Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">>;
  relations?: Array<{
    id?: string | null;
    type?: string | null;
    relatedIssue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null;
  }>;
  inverseRelations?: Array<{
    id?: string | null;
    type?: string | null;
    issue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null;
  }>;
}

export interface SearchIssuesInput {
  query: string;
  states?: string[];
  limit?: number;
}

export interface ManagedCreateIssueInput extends CreateIssueInput {
  assignee?: string;
  parent?: string;
  priority?: number;
}

export interface ManagedUpdateIssueInput extends UpdateIssueInput {
  title?: string;
  description?: string;
  assignee?: string;
  priority?: number;
  parent?: string | null;
}

export interface RiskPolicy {
  staleBusinessDays: number;
  urgentPriorityThreshold: number;
}

export interface RiskyLinearIssue extends LinearIssue {
  riskCategories: string[];
  ownerMissing: boolean;
  dueMissing: boolean;
  blocked: boolean;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

function requireEnv(env: LinearCommandEnv, key: "LINEAR_API_KEY" | "LINEAR_TEAM_KEY"): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function ensureLinearAuthConfigured(env: LinearCommandEnv): void {
  const hasApiKey = Boolean(env.LINEAR_API_KEY?.trim());
  const hasWorkspace = Boolean(env.LINEAR_WORKSPACE?.trim());

  if (!hasApiKey && !hasWorkspace) {
    throw new Error("Linear authentication is not configured. Set LINEAR_API_KEY or LINEAR_WORKSPACE-backed credentials.");
  }
}

function workspaceArgs(env: LinearCommandEnv): string[] {
  if (env.LINEAR_API_KEY?.trim()) return [];
  const workspace = env.LINEAR_WORKSPACE?.trim();
  return workspace ? ["-w", workspace] : [];
}

function parseIssueId(text: string): string | undefined {
  const match = stripAnsi(text).match(/\b[A-Z][A-Z0-9]+-\d+\b/);
  return match?.[0];
}

async function execLinear(
  args: string[],
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; combined: string }> {
  const result = await execFileAsync("linear", args, { env, signal });
  const stdout = stripAnsi(result.stdout ?? "").trim();
  const stderr = stripAnsi(result.stderr ?? "").trim();
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
  return {
    stdout,
    stderr,
    combined,
  };
}

async function execLinearJson<T>(
  args: string[],
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<T> {
  const result = await execLinear(args, env, signal);
  const raw = result.stdout || result.stderr;
  if (!raw) {
    throw new Error("linear command returned empty JSON output");
  }
  return JSON.parse(raw) as T;
}

async function queryLinearApi<T>(
  query: string,
  variables: Record<string, unknown>,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<T> {
  const data = await execLinearJson<{ data?: T; errors?: Array<{ message?: string }> }>(
    ["api", query, "--variables-json", JSON.stringify(variables)],
    env,
    signal,
  );

  if (data.errors?.length) {
    throw new Error(data.errors.map((error) => error.message ?? "Unknown Linear API error").join("\n"));
  }

  if (!data.data) {
    throw new Error("Linear API returned no data");
  }

  return data.data;
}

function normalizeIssue(issue: Partial<LinearIssue> | null | undefined): LinearIssue | undefined {
  if (!issue?.id || !issue.identifier || !issue.title) {
    return undefined;
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    description: issue.description ?? undefined,
    dueDate: issue.dueDate ?? undefined,
    priority: issue.priority ?? undefined,
    updatedAt: issue.updatedAt ?? undefined,
    assignee: issue.assignee ?? undefined,
    state: issue.state ?? undefined,
    parent: issue.parent ?? undefined,
    children: issue.children ?? [],
    relations: issue.relations ?? [],
    inverseRelations: issue.inverseRelations ?? [],
  };
}

function normalizeIssueWithConnections(
  issue: Omit<LinearIssue, "children" | "relations" | "inverseRelations"> & {
    children?: { nodes?: Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">> };
    relations?: {
      nodes?: Array<{ id?: string | null; type?: string | null; relatedIssue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null }>;
    };
    inverseRelations?: {
      nodes?: Array<{ id?: string | null; type?: string | null; issue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null }>;
    };
  },
): LinearIssue | undefined {
  const base = normalizeIssue({
    ...issue,
    children: [],
    relations: [],
    inverseRelations: [],
  });

  if (!base) return undefined;
  base.children = issue.children?.nodes ?? [];
  base.relations = issue.relations?.nodes ?? [];
  base.inverseRelations = issue.inverseRelations?.nodes ?? [];
  return base;
}

async function resolveIssue(env: LinearCommandEnv, issueId: string, signal?: AbortSignal): Promise<LinearIssue> {
  const data = await queryLinearApi<{
    issue: Omit<LinearIssue, "children" | "relations" | "inverseRelations"> & {
      children: { nodes: Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">> };
      relations: {
        nodes: Array<{ id?: string | null; type?: string | null; relatedIssue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null }>;
      };
      inverseRelations: {
        nodes: Array<{ id?: string | null; type?: string | null; issue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null }>;
      };
    };
  }>(
    `
      query ResolveIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          url
          description
          dueDate
          priority
          updatedAt
          assignee {
            id
            name
            displayName
            email
          }
          state {
            id
            name
            type
          }
          parent {
            id
            identifier
            title
            url
          }
          children(first: 20) {
            nodes {
              id
              identifier
              title
              url
            }
          }
          relations {
            nodes {
              id
              type
              relatedIssue {
                identifier
                title
                url
              }
            }
          }
          inverseRelations {
            nodes {
              id
              type
              issue {
                identifier
                title
                url
              }
            }
          }
        }
      }
    `,
    { id: issueId.trim() },
    env,
    signal,
  );

  const issue = normalizeIssueWithConnections(data.issue);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }
  return issue;
}

async function resolveTeamId(env: LinearCommandEnv, signal?: AbortSignal): Promise<string> {
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const data = await queryLinearApi<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
    `
      query ResolveTeamId($teamKey: String!) {
        teams(filter: { key: { eq: $teamKey } }) {
          nodes {
            id
            key
          }
        }
      }
    `,
    { teamKey },
    env,
    signal,
  );

  const team = data.teams.nodes[0];
  if (!team?.id) {
    throw new Error(`Unable to resolve team id for ${teamKey}`);
  }
  return team.id;
}

async function resolveWorkflowStateId(
  env: LinearCommandEnv,
  state: string,
  signal?: AbortSignal,
): Promise<string> {
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const normalized = state.trim().toLowerCase();
  const data = await queryLinearApi<{
    workflowStates: {
      nodes: Array<{ id: string; name: string; type: string }>;
    };
  }>(
    `
      query ResolveWorkflowState($teamKey: String!) {
        workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
          nodes {
            id
            name
            type
          }
        }
      }
    `,
    { teamKey },
    env,
    signal,
  );

  const match = data.workflowStates.nodes.find((workflowState) => {
    return (
      workflowState.name.toLowerCase() === normalized ||
      workflowState.type.toLowerCase() === normalized
    );
  });

  if (!match) {
    throw new Error(`Unable to resolve workflow state: ${state}`);
  }

  return match.id;
}

async function resolveUserId(
  env: LinearCommandEnv,
  assignee: string,
  signal?: AbortSignal,
): Promise<string> {
  const normalized = assignee.trim();
  if (!normalized) {
    throw new Error("Assignee is required");
  }

  const data = await queryLinearApi<{
    users: {
      nodes: Array<LinearUser>;
    };
  }>(
    `
      query ResolveUser($input: String!) {
        users(
          first: 10
          filter: {
            active: { eq: true }
            or: [
              { email: { eqIgnoreCase: $input } }
              { displayName: { eqIgnoreCase: $input } }
              { name: { containsIgnoreCaseAndAccent: $input } }
            ]
          }
        ) {
          nodes {
            id
            name
            displayName
            email
          }
        }
      }
    `,
    { input: normalized },
    env,
    signal,
  );

  const exactMatch = data.users.nodes.find((user) => {
    return (
      user.displayName?.toLowerCase() === normalized.toLowerCase() ||
      user.name?.toLowerCase() === normalized.toLowerCase() ||
      user.email?.toLowerCase() === normalized.toLowerCase()
    );
  });

  const resolved = exactMatch ?? data.users.nodes[0];
  if (!resolved?.id) {
    throw new Error(`Unable to resolve assignee: ${assignee}`);
  }

  return resolved.id;
}

async function bestEffortIssueUrl(
  issueId: string,
  env: LinearCommandEnv,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await execLinear(buildIssueUrlArgs(issueId, env), env, signal);
    return result.stdout || result.stderr || undefined;
  } catch {
    return undefined;
  }
}

export async function verifyLinearCli(teamKey: string): Promise<void> {
  await execFileAsync("linear", ["--version"], { env: process.env });

  const whoami = await execFileAsync("linear", ["auth", "whoami"], {
    env: process.env,
  });

  if (!whoami.stdout.trim()) {
    throw new Error("linear auth whoami returned empty output");
  }

  const teamList = await execFileAsync("linear", ["team", "list"], {
    env: process.env,
  });

  const lines = teamList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const hasTeam = lines.some((line) => line.startsWith(`${teamKey} `) || line === teamKey);
  if (!hasTeam) {
    throw new Error(`LINEAR_TEAM_KEY "${teamKey}" was not found in linear team list output`);
  }
}

export function buildCreateIssueArgs(input: CreateIssueInput, env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  const title = input.title.trim();
  const description = input.description.trim();
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");

  if (!title) {
    throw new Error("Issue title is required");
  }
  if (!description) {
    throw new Error("Issue description is required");
  }

  const args = ["issue", "create", "--no-interactive", "--title", title, "--description", description];
  args.push(...workspaceArgs(env), "--team", teamKey);

  if (input.state?.trim()) {
    args.push("--state", input.state.trim());
  }

  if (input.dueDate?.trim()) {
    args.push("--due-date", input.dueDate.trim());
  }

  return args;
}

export function buildListActiveIssuesArgs(limit = 20, env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 20;

  return [
    "issue",
    "list",
    "--all-assignees",
    "--limit",
    String(normalizedLimit),
    "--no-pager",
    "--sort",
    "manual",
    "-s",
    "unstarted",
    "-s",
    "started",
    ...workspaceArgs(env),
    "--team",
    teamKey,
  ];
}

export function buildUpdateIssueArgs(input: UpdateIssueInput, env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);

  const issueId = input.issueId.trim();
  if (!issueId) {
    throw new Error("Issue ID is required");
  }

  const workspace = workspaceArgs(env);
  const args = ["issue", "update", ...workspace, issueId];
  const state = input.state?.trim();
  const dueDate = input.dueDate?.trim();

  if (state) {
    args.push("--state", state);
  }

  if (dueDate) {
    args.push("--due-date", dueDate);
  }

  if (input.clearDueDate) {
    args.push("--clear-due-date");
  }

  if (args.length === 3 + workspace.length) {
    throw new Error("At least one update field is required");
  }

  return args;
}

export function buildIssueUrlArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) {
    throw new Error("Issue ID is required");
  }

  return ["issue", "url", ...workspaceArgs(env), trimmed];
}

export async function createLinearIssue(
  input: CreateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssueResult> {
  const created = await execLinear(buildCreateIssueArgs(input, env), env, signal);
  const issueId = parseIssueId(created.combined);
  const url = issueId ? await bestEffortIssueUrl(issueId, env, signal) : undefined;

  return {
    issueId,
    title: input.title.trim(),
    url,
    output: created.combined,
  };
}

export async function listActiveLinearIssues(
  limit = 20,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearListResult> {
  const listed = await execLinear(buildListActiveIssuesArgs(limit, env), env, signal);
  return {
    output: listed.combined,
  };
}

export async function updateLinearIssue(
  input: UpdateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssueResult> {
  const moved = await execLinear(buildUpdateIssueArgs(input, env), env, signal);
  const url = await bestEffortIssueUrl(input.issueId, env, signal);

  return {
    issueId: input.issueId.trim(),
    url,
    output: moved.combined,
  };
}

export async function getLinearIssue(
  issueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  return resolveIssue(env, issueId, signal);
}

export async function searchLinearIssues(
  input: SearchIssuesInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue[]> {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const query = input.query.trim();
  const limit = Number.isFinite(input.limit) && input.limit && input.limit > 0 ? Math.trunc(input.limit) : 10;
  if (!query) {
    return [];
  }

  const states = input.states?.length ? input.states : ["triage", "backlog", "unstarted", "started"];
  const data = await queryLinearApi<{
    issues: {
      nodes: LinearIssue[];
    };
  }>(
    `
      query SearchIssues($teamKey: String!, $query: String!, $states: [String!], $first: Int!) {
        issues(
          first: $first
          filter: {
            team: { key: { eq: $teamKey } }
            state: { type: { in: $states } }
            title: { containsIgnoreCase: $query }
          }
        ) {
          nodes {
            id
            identifier
            title
            url
            dueDate
            updatedAt
            priority
            assignee {
              id
              name
              displayName
              email
            }
            state {
              id
              name
              type
            }
            parent {
              id
              identifier
              title
              url
            }
          }
        }
      }
    `,
    {
      teamKey,
      query,
      states,
      first: limit,
    },
    env,
    signal,
  );

  return data.issues.nodes.map((issue) => normalizeIssue(issue)).filter(Boolean) as LinearIssue[];
}

export async function createManagedLinearIssue(
  input: ManagedCreateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  ensureLinearAuthConfigured(env);
  const teamId = await resolveTeamId(env, signal);

  const issueInput: Record<string, unknown> = {
    teamId,
    title: input.title.trim(),
    description: input.description.trim(),
  };

  if (input.dueDate?.trim()) issueInput.dueDate = input.dueDate.trim();
  if (input.priority != null) issueInput.priority = input.priority;
  if (input.assignee?.trim()) issueInput.assigneeId = await resolveUserId(env, input.assignee, signal);
  if (input.parent?.trim()) issueInput.parentId = (await resolveIssue(env, input.parent, signal)).id;
  if (input.state?.trim()) issueInput.stateId = await resolveWorkflowStateId(env, input.state, signal);

  const data = await queryLinearApi<{
    issueCreate: {
      success: boolean;
      issue: LinearIssue;
    };
  }>(
    `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
            url
            dueDate
            priority
            updatedAt
            assignee {
              id
              name
              displayName
              email
            }
            state {
              id
              name
              type
            }
            parent {
              id
              identifier
              title
              url
            }
          }
        }
      }
    `,
    { input: issueInput },
    env,
    signal,
  );

  if (!data.issueCreate.success) {
    throw new Error("Linear issue creation failed");
  }

  const issue = normalizeIssue(data.issueCreate.issue);
  if (!issue) {
    throw new Error("Linear issue creation returned no issue");
  }
  return issue;
}

export async function updateManagedLinearIssue(
  input: ManagedUpdateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  ensureLinearAuthConfigured(env);
  const existing = await resolveIssue(env, input.issueId, signal);
  const updateInput: Record<string, unknown> = {};

  if (input.title?.trim()) updateInput.title = input.title.trim();
  if (input.description?.trim()) updateInput.description = input.description.trim();
  if (input.dueDate?.trim()) updateInput.dueDate = input.dueDate.trim();
  if (input.clearDueDate) updateInput.dueDate = null;
  if (input.priority != null) updateInput.priority = input.priority;
  if (input.assignee?.trim()) updateInput.assigneeId = await resolveUserId(env, input.assignee, signal);
  if (input.parent !== undefined) {
    updateInput.parentId = input.parent === null ? null : (await resolveIssue(env, input.parent, signal)).id;
  }
  if (input.state?.trim()) updateInput.stateId = await resolveWorkflowStateId(env, input.state, signal);

  if (Object.keys(updateInput).length === 0) {
    throw new Error("At least one update field is required");
  }

  const data = await queryLinearApi<{
    issueUpdate: {
      success: boolean;
      issue: LinearIssue;
    };
  }>(
    `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            title
            url
            dueDate
            priority
            updatedAt
            assignee {
              id
              name
              displayName
              email
            }
            state {
              id
              name
              type
            }
            parent {
              id
              identifier
              title
              url
            }
          }
        }
      }
    `,
    {
      id: existing.id,
      input: updateInput,
    },
    env,
    signal,
  );

  if (!data.issueUpdate.success) {
    throw new Error("Linear issue update failed");
  }

  const issue = normalizeIssue(data.issueUpdate.issue);
  if (!issue) {
    throw new Error("Linear issue update returned no issue");
  }
  return issue;
}

export async function assignLinearIssue(
  issueId: string,
  assignee: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  return updateManagedLinearIssue({ issueId, assignee }, env, signal);
}

export async function addLinearComment(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ id: string; url?: string | null; body: string }> {
  const issue = await resolveIssue(env, issueId, signal);
  const data = await queryLinearApi<{
    commentCreate: {
      success: boolean;
      comment: { id: string; url?: string | null; body: string };
    };
  }>(
    `
      mutation AddComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment {
            id
            url
            body
          }
        }
      }
    `,
    {
      input: {
        issueId: issue.id,
        body,
      },
    },
    env,
    signal,
  );

  if (!data.commentCreate.success || !data.commentCreate.comment) {
    throw new Error("Failed to add Linear comment");
  }

  return data.commentCreate.comment;
}

export async function addLinearRelation(
  issueId: string,
  relationType: "blocks" | "blocked-by",
  relatedIssueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<void> {
  const issue = await resolveIssue(env, issueId, signal);
  const related = await resolveIssue(env, relatedIssueId, signal);
  const [fromId, toId] = relationType === "blocked-by"
    ? [related.id, issue.id]
    : [issue.id, related.id];

  const data = await queryLinearApi<{
    issueRelationCreate: {
      success: boolean;
      issueRelation?: { id: string };
    };
  }>(
    `
      mutation AddIssueRelation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) {
          success
          issueRelation {
            id
          }
        }
      }
    `,
    {
      input: {
        issueId: fromId,
        relatedIssueId: toId,
        type: "blocks",
      },
    },
    env,
    signal,
  );

  if (!data.issueRelationCreate.success) {
    throw new Error("Failed to create Linear relation");
  }
}

export async function listLinearTeamMembers(
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearUser[]> {
  ensureLinearAuthConfigured(env);
  const data = await queryLinearApi<{
    users: {
      nodes: LinearUser[];
    };
  }>(
    `
      query ListUsers {
        users(first: 50, filter: { active: { eq: true } }) {
          nodes {
            id
            name
            displayName
            email
          }
        }
      }
    `,
    {},
    env,
    signal,
  );

  return data.users.nodes;
}

export async function listRiskyLinearIssues(
  _policy: RiskPolicy,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue[]> {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const data = await queryLinearApi<{
    issues: {
      nodes: Array<
        Omit<LinearIssue, "children" | "relations" | "inverseRelations"> & {
          children: { nodes: Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">> };
          relations: {
            nodes: Array<{ id?: string | null; type?: string | null; relatedIssue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null }>;
          };
          inverseRelations: {
            nodes: Array<{ id?: string | null; type?: string | null; issue?: Pick<LinearIssue, "identifier" | "title" | "url"> | null }>;
          };
        }
      >;
    };
  }>(
    `
      query ListRiskyIssues($teamKey: String!) {
        issues(
          first: 100
          filter: {
            team: { key: { eq: $teamKey } }
            state: { type: { nin: ["completed", "canceled"] } }
          }
        ) {
          nodes {
            id
            identifier
            title
            url
            description
            dueDate
            priority
            updatedAt
            assignee {
              id
              name
              displayName
              email
            }
            state {
              id
              name
              type
            }
            parent {
              id
              identifier
              title
              url
            }
            children(first: 20) {
              nodes {
                id
                identifier
                title
                url
              }
            }
            relations {
              nodes {
                id
                type
                relatedIssue {
                  identifier
                  title
                  url
                }
              }
            }
            inverseRelations {
              nodes {
                id
                type
                issue {
                  identifier
                  title
                  url
                }
              }
            }
          }
        }
      }
    `,
    { teamKey },
    env,
    signal,
  );

  return data.issues.nodes
    .map((issue) => {
      const normalized = normalizeIssueWithConnections(issue);
      if (!normalized) return undefined;
      return normalized;
    })
    .filter(Boolean) as LinearIssue[];
}
