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

export interface UpdateIssueStateInput {
  issueId: string;
  state: string;
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

export function buildUpdateIssueStateArgs(
  input: UpdateIssueStateInput,
  env: LinearCommandEnv = process.env,
): string[] {
  ensureLinearAuthConfigured(env);

  const issueId = input.issueId.trim();
  const state = input.state.trim();
  if (!issueId) {
    throw new Error("Issue ID is required");
  }
  if (!state) {
    throw new Error("Issue state is required");
  }

  return ["issue", "move", ...workspaceArgs(env), issueId, state];
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

export async function updateLinearIssueState(
  input: UpdateIssueStateInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssueResult> {
  const moved = await execLinear(buildUpdateIssueStateArgs(input, env), env, signal);
  const url = await bestEffortIssueUrl(input.issueId, env, signal);

  return {
    issueId: input.issueId.trim(),
    url,
    output: moved.combined,
  };
}
