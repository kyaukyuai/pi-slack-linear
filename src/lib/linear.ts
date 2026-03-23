import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export interface LinearCycle {
  id?: string;
  number?: number;
  name?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
  description?: string | null;
  dueDate?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  cycle?: LinearCycle | null;
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
  comments?: Array<{
    id: string;
    body: string;
    createdAt?: string | null;
    user?: Pick<LinearUser, "name" | "displayName"> | null;
  }>;
  latestActionKind?: "progress" | "blocked" | "slack-source" | "other";
  latestActionAt?: string | null;
}

export interface SearchIssuesInput {
  query: string;
  states?: string[];
  limit?: number;
  parent?: string;
  priority?: number | string;
  updatedBefore?: string;
  dueBefore?: string;
  allStates?: boolean;
  allAssignees?: boolean;
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
  comment?: string;
}

export interface ManagedCreateIssueBatchInput {
  parent: ManagedCreateIssueInput;
  children: ManagedCreateIssueInput[];
}

export interface ManagedCreateIssueBatchResult {
  parent: LinearIssue;
  children: LinearIssue[];
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

export interface LinearBlockedUpdateResult {
  issue: LinearIssue;
  commentId?: string;
  blockedStateApplied: boolean;
}

interface CliIssueState {
  id?: string;
  name?: string;
  color?: string;
  type?: string | null;
}

interface CliIssueUser {
  id?: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  initials?: string | null;
  active?: boolean;
  description?: string | null;
  timezone?: string | null;
  lastSeen?: string | null;
  statusEmoji?: string | null;
  statusLabel?: string | null;
  guest?: boolean;
  isAssignable?: boolean;
}

interface CliIssueRef {
  id?: string;
  identifier?: string;
  title?: string;
  url?: string | null;
  dueDate?: string | null;
  state?: CliIssueState | null;
}

interface CliIssuePayload extends CliIssueRef {
  description?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  updatedAt?: string | null;
  assignee?: CliIssueUser | null;
  cycle?: {
    id?: string;
    number?: number | null;
    name?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
  } | null;
  parent?: CliIssueRef | null;
  children?: CliIssueRef[] | { nodes?: CliIssueRef[] } | null;
  relations?: unknown;
  comments?: Array<{
    id?: string;
    body?: string | null;
    createdAt?: string | null;
    user?: CliIssueUser | null;
  }> | null;
}

interface CliRelationListPayload {
  issue?: CliIssueRef;
  outgoing?: Array<{
    id?: string | null;
    type?: string | null;
    issue?: CliIssueRef | null;
  }>;
  incoming?: Array<{
    id?: string | null;
    type?: string | null;
    issue?: CliIssueRef | null;
  }>;
}

interface CliTeamMembersPayload {
  team?: string;
  members?: CliIssueUser[];
}

interface CliIssueParentPayload {
  issue?: CliIssueRef;
  parent?: CliIssueRef | null;
}

interface CliIssueChildrenPayload {
  issue?: CliIssueRef;
  children?: CliIssueRef[];
}

interface CliCommentPayload {
  id?: string;
  body?: string;
  url?: string | null;
}

interface CliBatchCreatePayload {
  parent?: CliIssuePayload;
  children?: CliIssuePayload[];
}

interface BatchIssueSpec {
  title: string;
  description: string;
  assignee?: string;
  dueDate?: string;
  priority?: number;
  state?: string;
}

export interface GetLinearIssueOptions {
  includeComments?: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return toStringOrUndefined(value);
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toIssueRef(raw: unknown): Pick<LinearIssue, "id" | "identifier" | "title" | "url"> | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStringOrUndefined(raw.id);
  const identifier = toStringOrUndefined(raw.identifier);
  const title = toStringOrUndefined(raw.title);
  if (!id || !identifier || !title) return undefined;
  return {
    id,
    identifier,
    title,
    url: toNullableString(raw.url) ?? undefined,
  };
}

function normalizeLinearUser(raw: unknown): LinearUser | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStringOrUndefined(raw.id);
  if (!id) return undefined;
  return {
    id,
    name: toNullableString(raw.name),
    displayName: toNullableString(raw.displayName),
    email: toNullableString(raw.email),
  };
}

function normalizeLinearState(raw: unknown): LinearWorkflowState | undefined {
  if (!isRecord(raw)) return undefined;
  const name = toStringOrUndefined(raw.name);
  if (!name) return undefined;
  return {
    id: toStringOrUndefined(raw.id) ?? name,
    name,
    type: toNullableString(raw.type),
  };
}

function normalizeLinearCycle(raw: unknown): LinearCycle | undefined {
  if (!isRecord(raw)) return undefined;

  const id = toStringOrUndefined(raw.id);
  const number = toNumberOrUndefined(raw.number);
  const name = toNullableString(raw.name);
  const startsAt = toNullableString(raw.startsAt);
  const endsAt = toNullableString(raw.endsAt);

  if (!id && number == null && !name) {
    return undefined;
  }

  return {
    id,
    number,
    name,
    startsAt,
    endsAt,
  };
}

function normalizeLinearComment(raw: unknown): NonNullable<LinearIssue["comments"]>[number] | undefined {
  if (!isRecord(raw)) return undefined;
  const id = toStringOrUndefined(raw.id);
  const body = toStringOrUndefined(raw.body);
  if (!id || !body) return undefined;
  return {
    id,
    body,
    createdAt: toNullableString(raw.createdAt),
    user: normalizeLinearUser(raw.user)
      ? {
          name: normalizeLinearUser(raw.user)?.name ?? undefined,
          displayName: normalizeLinearUser(raw.user)?.displayName ?? undefined,
        }
      : null,
  };
}

function deriveLatestActionKind(body: string): LinearIssue["latestActionKind"] {
  const trimmed = body.trim();
  if (trimmed.startsWith("## Progress update")) return "progress";
  if (trimmed.startsWith("## Blocked update")) return "blocked";
  if (trimmed.startsWith("## Slack source")) return "slack-source";
  return "other";
}

function normalizeEmbeddedRelations(raw: unknown): Pick<LinearIssue, "relations" | "inverseRelations"> {
  if (!isRecord(raw)) {
    return { relations: [], inverseRelations: [] };
  }

  const relations: NonNullable<LinearIssue["relations"]> = [];
  const inverseRelations: NonNullable<LinearIssue["inverseRelations"]> = [];

  const pushOutgoing = (items: unknown, type: string) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const relatedIssue = toIssueRef(item);
      if (!relatedIssue) continue;
      relations.push({
        id: toNullableString(item.relationId) ?? toNullableString(item.id) ?? undefined,
        type,
        relatedIssue,
      });
    }
  };

  const pushIncoming = (items: unknown, type: string) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const issue = toIssueRef(item);
      if (!issue) continue;
      inverseRelations.push({
        id: toNullableString(item.relationId) ?? toNullableString(item.id) ?? undefined,
        type,
        issue,
      });
    }
  };

  pushOutgoing(raw.blocks, "blocks");
  pushOutgoing(raw.related, "related");
  pushIncoming(raw.blockedBy, "blocked-by");
  pushIncoming(raw.duplicatedBy, "duplicate");

  const duplicateOf = toIssueRef(raw.duplicateOf);
  if (duplicateOf) {
    relations.push({
      id: isRecord(raw.duplicateOf) ? toNullableString(raw.duplicateOf.relationId) ?? undefined : undefined,
      type: "duplicate",
      relatedIssue: duplicateOf,
    });
  }

  return { relations, inverseRelations };
}

export function normalizeRelationListPayload(raw: unknown): Pick<LinearIssue, "relations" | "inverseRelations"> {
  if (!isRecord(raw)) {
    return { relations: [], inverseRelations: [] };
  }

  const relations = Array.isArray(raw.outgoing)
    ? raw.outgoing
      .map((item) => {
        if (!isRecord(item)) return undefined;
        return {
          id: toNullableString(item.id) ?? undefined,
          type: toNullableString(item.type) ?? undefined,
          relatedIssue: toIssueRef(item.issue),
        };
      })
      .filter((item) => item?.relatedIssue) as NonNullable<LinearIssue["relations"]>
    : [];

  const inverseRelations = Array.isArray(raw.incoming)
    ? raw.incoming
      .map((item) => {
        if (!isRecord(item)) return undefined;
        return {
          id: toNullableString(item.id) ?? undefined,
          type: toNullableString(item.type) ?? undefined,
          issue: toIssueRef(item.issue),
        };
      })
      .filter((item) => item?.issue) as NonNullable<LinearIssue["inverseRelations"]>
    : [];

  return { relations, inverseRelations };
}

export function normalizeTeamMembersPayload(raw: unknown): LinearUser[] {
  if (!isRecord(raw) || !Array.isArray(raw.members)) return [];
  return raw.members.map((member) => normalizeLinearUser(member)).filter(Boolean) as LinearUser[];
}

export function normalizeLinearIssuePayload(raw: unknown): LinearIssue | undefined {
  if (!isRecord(raw)) return undefined;

  const id = toStringOrUndefined(raw.id);
  const identifier = toStringOrUndefined(raw.identifier);
  const title = toStringOrUndefined(raw.title);
  if (!id || !identifier || !title) return undefined;

  const childrenSource = Array.isArray(raw.children)
    ? raw.children
    : isRecord(raw.children) && Array.isArray(raw.children.nodes)
      ? raw.children.nodes
      : [];

  const children = childrenSource.map((child) => toIssueRef(child)).filter(Boolean) as NonNullable<LinearIssue["children"]>;
  const embeddedRelations = normalizeEmbeddedRelations(raw.relations);
  const comments = Array.isArray(raw.comments)
    ? raw.comments.map((comment) => normalizeLinearComment(comment)).filter(Boolean) as NonNullable<LinearIssue["comments"]>
    : [];
  const latestComment = [...comments].sort((left, right) => {
    return Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? "");
  })[0];

  return {
    id,
    identifier,
    title,
    url: toNullableString(raw.url),
    description: toNullableString(raw.description),
    dueDate: toNullableString(raw.dueDate),
    priority: toNumberOrUndefined(raw.priority),
    priorityLabel: toNullableString(raw.priorityLabel),
    cycle: normalizeLinearCycle(raw.cycle) ?? null,
    updatedAt: toNullableString(raw.updatedAt),
    assignee: normalizeLinearUser(raw.assignee) ?? null,
    state: normalizeLinearState(raw.state) ?? null,
    parent: toIssueRef(raw.parent) ?? null,
    children,
    relations: embeddedRelations.relations,
    inverseRelations: embeddedRelations.inverseRelations,
    comments,
    latestActionKind: latestComment ? deriveLatestActionKind(latestComment.body) : undefined,
    latestActionAt: latestComment?.createdAt ?? null,
  };
}

function formatIssueResultOutput(issue: LinearIssue, action: string): string {
  const lines = [`${action}: ${issue.identifier}`];
  lines.push(issue.title);
  if (issue.url) lines.push(issue.url);
  return lines.join("\n");
}

function normalizeVersion(version: string): number[] {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function execLinear(
  args: string[],
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; combined: string }> {
  try {
    const result = await execFileAsync("linear", args, { env, signal });
    const stdout = stripAnsi(result.stdout ?? "").trim();
    const stderr = stripAnsi(result.stderr ?? "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { stdout, stderr, combined };
  } catch (error) {
    const stdout = stripAnsi(String((error as { stdout?: string }).stdout ?? "")).trim();
    const stderr = stripAnsi(String((error as { stderr?: string }).stderr ?? "")).trim();
    const message = error instanceof Error ? error.message : String(error);
    const combined = [stdout, stderr, message].filter(Boolean).join("\n").trim();
    throw new Error(combined || `linear ${args.join(" ")} failed`);
  }
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

async function resolveAssigneeSpecifier(
  env: LinearCommandEnv,
  assignee: string | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const normalized = assignee?.trim();
  if (!normalized) return undefined;
  if (normalized.toLowerCase() === "self") return "self";

  const lowered = normalized.toLowerCase();
  const members = await listLinearTeamMembers(env, signal).catch(() => []);
  const exact = members.find((member) => {
    return [member.name, member.displayName, member.email, member.id]
      .filter(Boolean)
      .some((candidate) => candidate?.toLowerCase() === lowered);
  });

  return exact?.name ?? exact?.email ?? exact?.displayName ?? normalized;
}

function buildManagedCreateIssueArgs(
  input: ManagedCreateIssueInput,
  env: LinearCommandEnv = process.env,
  assignee?: string,
): string[] {
  ensureLinearAuthConfigured(env);
  const title = input.title.trim();
  const description = input.description.trim();
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");

  if (!title) throw new Error("Issue title is required");
  if (!description) throw new Error("Issue description is required");

  const args = [
    "issue",
    "create",
    ...workspaceArgs(env),
    "--no-interactive",
    "--title",
    title,
    "--description",
    description,
    "--team",
    teamKey,
    "--json",
  ];

  if (input.state?.trim()) args.push("--state", input.state.trim());
  if (input.dueDate?.trim()) args.push("--due-date", input.dueDate.trim());
  if (input.priority != null) args.push("--priority", String(input.priority));
  if (assignee?.trim()) args.push("--assignee", assignee.trim());
  if (input.parent?.trim()) args.push("--parent", input.parent.trim());

  return args;
}

function buildManagedUpdateIssueArgs(
  input: ManagedUpdateIssueInput,
  env: LinearCommandEnv = process.env,
  assignee?: string,
): string[] {
  ensureLinearAuthConfigured(env);
  const issueId = input.issueId.trim();
  if (!issueId) throw new Error("Issue ID is required");

  const args = ["issue", "update", ...workspaceArgs(env), issueId, "--json"];

  if (input.title?.trim()) args.push("--title", input.title.trim());
  if (input.description?.trim()) args.push("--description", input.description.trim());
  if (input.state?.trim()) args.push("--state", input.state.trim());
  if (input.dueDate?.trim()) args.push("--due-date", input.dueDate.trim());
  if (input.clearDueDate) args.push("--clear-due-date");
  if (input.priority != null) args.push("--priority", String(input.priority));
  if (assignee?.trim()) args.push("--assignee", assignee.trim());
  if (input.parent?.trim()) args.push("--parent", input.parent.trim());
  if (input.comment?.trim()) args.push("--comment", input.comment.trim());
  if (input.parent === null) {
    throw new Error("Clearing parent relationships is not supported by linear-cli v2.4.0");
  }

  if (args.length === 4 + workspaceArgs(env).length) {
    throw new Error("At least one update field is required");
  }

  return args;
}

function buildBatchIssueSpec(input: ManagedCreateIssueInput, assignee?: string): BatchIssueSpec {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new Error("Issue title is required");
  if (!description) throw new Error("Issue description is required");

  return {
    title,
    description,
    assignee: assignee?.trim() || undefined,
    dueDate: input.dueDate?.trim() || undefined,
    priority: input.priority,
    state: input.state?.trim() || undefined,
  };
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

export function buildGetIssueArgs(
  issueId: string,
  env: LinearCommandEnv = process.env,
  options: GetLinearIssueOptions = {},
): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  const args = ["issue", "view", ...workspaceArgs(env), trimmed, "--json"];
  if (!options.includeComments) {
    args.push("--no-comments");
  }
  return args;
}

export function buildSearchIssuesArgs(input: SearchIssuesInput, env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const query = input.query.trim();
  const limit = Number.isFinite(input.limit) && input.limit != null && input.limit >= 0 ? Math.trunc(input.limit) : 10;
  if (!query) throw new Error("Search query is required");

  const args = [
    "issue",
    "list",
    "--json",
    "--no-pager",
    "--limit",
    String(limit),
    "--sort",
    "manual",
    ...workspaceArgs(env),
    "--team",
    teamKey,
  ];

  if (input.allAssignees ?? true) {
    args.push("--all-assignees");
  }

  if (input.allStates) {
    args.push("--all-states");
  } else {
    const states = input.states?.length ? input.states : ["triage", "backlog", "unstarted", "started"];
    for (const state of states) {
      args.push("-s", state);
    }
  }

  args.push("--query", query);

  if (input.parent?.trim()) args.push("--parent", input.parent.trim());
  if (input.priority != null) args.push("--priority", String(input.priority));
  if (input.updatedBefore?.trim()) args.push("--updated-before", input.updatedBefore.trim());
  if (input.dueBefore?.trim()) args.push("--due-before", input.dueBefore.trim());

  return args;
}

export function buildIssueCommentAddArgs(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
): string[] {
  const trimmedIssueId = issueId.trim();
  const trimmedBody = body.trim();
  if (!trimmedIssueId) throw new Error("Issue ID is required");
  if (!trimmedBody) throw new Error("Comment body is required");

  return ["issue", "comment", "add", ...workspaceArgs(env), trimmedIssueId, "--body", trimmedBody, "--json"];
}

export function buildIssueRelationAddArgs(
  issueId: string,
  relationType: "blocks" | "blocked-by",
  relatedIssueId: string,
  env: LinearCommandEnv = process.env,
): string[] {
  const from = issueId.trim();
  const to = relatedIssueId.trim();
  if (!from || !to) throw new Error("Issue IDs are required");
  return ["issue", "relation", "add", ...workspaceArgs(env), from, relationType, to, "--json"];
}

export function buildIssueRelationListArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  return ["issue", "relation", "list", ...workspaceArgs(env), trimmed, "--json"];
}

export function buildTeamMembersArgs(env: LinearCommandEnv = process.env): string[] {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  return ["team", "members", ...workspaceArgs(env), teamKey, "--json"];
}

export function buildIssueParentArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  return ["issue", "parent", ...workspaceArgs(env), trimmed, "--json"];
}

export function buildIssueChildrenArgs(issueId: string, env: LinearCommandEnv = process.env): string[] {
  const trimmed = issueId.trim();
  if (!trimmed) throw new Error("Issue ID is required");
  return ["issue", "children", ...workspaceArgs(env), trimmed, "--json"];
}

export function buildCreateBatchArgs(filePath: string, env: LinearCommandEnv = process.env): string[] {
  if (!filePath.trim()) throw new Error("Batch file path is required");
  return ["issue", "create-batch", ...workspaceArgs(env), "--file", filePath, "--json"];
}

async function loadIssueRelations(
  issueId: string,
  env: LinearCommandEnv,
  signal?: AbortSignal,
): Promise<Pick<LinearIssue, "relations" | "inverseRelations">> {
  const payload = await execLinearJson<CliRelationListPayload>(buildIssueRelationListArgs(issueId, env), env, signal);
  return normalizeRelationListPayload(payload);
}

export async function verifyLinearCli(teamKey: string): Promise<void> {
  const versionResult = await execLinear(["--version"], process.env);
  const version = versionResult.stdout || versionResult.stderr;
  if (compareVersions(version, "2.7.0") < 0) {
    throw new Error(`linear-cli v2.7.0 or newer is required. Current version: ${version || "unknown"}`);
  }

  const whoami = await execLinear(["auth", "whoami"], process.env);
  if (!(whoami.stdout || whoami.stderr).trim()) {
    throw new Error("linear auth whoami returned empty output");
  }

  await execLinear(["issue", "children", "--help"], process.env);
  await execLinear(["issue", "parent", "--help"], process.env);
  await execLinear(["issue", "create-batch", "--help"], process.env);
  await execLinear(["team", "members", "--help"], process.env);

  const teamList = await execLinear(["team", "list"], process.env);
  const lines = teamList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const hasTeam = lines.some((line) => line.startsWith(`${teamKey} `) || line === teamKey);
  if (!hasTeam) {
    throw new Error(`LINEAR_TEAM_KEY "${teamKey}" was not found in linear team list output`);
  }
}

export async function createLinearIssue(
  input: CreateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssueResult> {
  const issue = await createManagedLinearIssue(input, env, signal);
  return {
    issueId: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    output: formatIssueResultOutput(issue, "Created issue"),
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
  const issue = await updateManagedLinearIssue(input, env, signal);
  return {
    issueId: issue.identifier,
    title: issue.title,
    url: issue.url ?? undefined,
    output: formatIssueResultOutput(issue, "Updated issue"),
  };
}

export async function getLinearIssue(
  issueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
  options: GetLinearIssueOptions = {},
): Promise<LinearIssue> {
  const payload = await execLinearJson<CliIssuePayload>(buildGetIssueArgs(issueId, env, options), env, signal);
  const issue = normalizeLinearIssuePayload(payload);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }
  return issue;
}

export async function getLinearIssueParent(
  issueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<Pick<LinearIssue, "id" | "identifier" | "title" | "url"> | null> {
  const payload = await execLinearJson<CliIssueParentPayload>(buildIssueParentArgs(issueId, env), env, signal);
  return toIssueRef(payload.parent) ?? null;
}

export async function getLinearIssueChildren(
  issueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">>> {
  const payload = await execLinearJson<CliIssueChildrenPayload>(buildIssueChildrenArgs(issueId, env), env, signal);
  return Array.isArray(payload.children)
    ? payload.children.map((child) => toIssueRef(child)).filter(Boolean) as Array<Pick<LinearIssue, "id" | "identifier" | "title" | "url">>
    : [];
}

export async function searchLinearIssues(
  input: SearchIssuesInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue[]> {
  ensureLinearAuthConfigured(env);
  const query = input.query.trim();
  if (!query) {
    return [];
  }

  const payload = await execLinearJson<CliIssuePayload[]>(buildSearchIssuesArgs(input, env), env, signal);
  return payload.map((issue) => normalizeLinearIssuePayload(issue)).filter(Boolean) as LinearIssue[];
}

export async function createManagedLinearIssue(
  input: ManagedCreateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  const assignee = await resolveAssigneeSpecifier(env, input.assignee, signal);
  const payload = await execLinearJson<CliIssuePayload>(buildManagedCreateIssueArgs(input, env, assignee), env, signal);
  const issue = normalizeLinearIssuePayload(payload);
  if (!issue) {
    throw new Error("Linear issue creation returned no issue");
  }
  return issue;
}

export async function createManagedLinearIssueBatch(
  input: ManagedCreateIssueBatchInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<ManagedCreateIssueBatchResult> {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const tempDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-batch-"));
  const batchFilePath = join(tempDir, "issue-batch.json");

  try {
    const parentAssignee = await resolveAssigneeSpecifier(env, input.parent.assignee, signal);
    const children = await Promise.all(
      input.children.map(async (child) => buildBatchIssueSpec(child, await resolveAssigneeSpecifier(env, child.assignee, signal))),
    );

    const batchPayload = {
      team: teamKey,
      parent: buildBatchIssueSpec(input.parent, parentAssignee),
      children,
    };

    await writeFile(batchFilePath, JSON.stringify(batchPayload, null, 2), "utf8");

    const payload = await execLinearJson<CliBatchCreatePayload>(buildCreateBatchArgs(batchFilePath, env), env, signal);
    const parent = normalizeLinearIssuePayload(payload.parent);
    if (!parent) {
      throw new Error("Linear issue batch creation returned no parent issue");
    }

    const normalizedChildren = Array.isArray(payload.children)
      ? payload.children.map((child) => normalizeLinearIssuePayload(child)).filter(Boolean) as LinearIssue[]
      : [];

    return {
      parent,
      children: normalizedChildren,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function updateManagedLinearIssue(
  input: ManagedUpdateIssueInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  const assignee = await resolveAssigneeSpecifier(env, input.assignee, signal);
  const payload = await execLinearJson<CliIssuePayload>(buildManagedUpdateIssueArgs(input, env, assignee), env, signal);
  const issue = normalizeLinearIssuePayload(payload);
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

export async function updateLinearIssueState(
  issueId: string,
  state: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  return updateManagedLinearIssue({ issueId, state }, env, signal);
}

export async function updateLinearIssueStateWithComment(
  issueId: string,
  state: string,
  comment: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue> {
  return updateManagedLinearIssue({ issueId, state, comment }, env, signal);
}

export async function addLinearComment(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ id: string; url?: string | null; body: string }> {
  const payload = await execLinearJson<CliCommentPayload>(buildIssueCommentAddArgs(issueId, body, env), env, signal);
  const id = toStringOrUndefined(payload.id);
  if (!id) {
    throw new Error("Failed to add Linear comment");
  }
  return {
    id,
    url: toNullableString(payload.url),
    body: toStringOrUndefined(payload.body) ?? body,
  };
}

export async function addLinearProgressComment(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<{ id: string; url?: string | null; body: string }> {
  return addLinearComment(issueId, `## Progress update\n${body.trim()}`, env, signal);
}

export async function markLinearIssueBlocked(
  issueId: string,
  body: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearBlockedUpdateResult> {
  const comment = await addLinearComment(issueId, `## Blocked update\n${body.trim()}`, env, signal);
  try {
    const issue = await updateManagedLinearIssue({ issueId, state: "blocked" }, env, signal);
    return {
      issue,
      commentId: comment.id,
      blockedStateApplied: true,
    };
  } catch {
    const issue = await getLinearIssue(issueId, env, signal);
    return {
      issue,
      commentId: comment.id,
      blockedStateApplied: false,
    };
  }
}

export async function addLinearRelation(
  issueId: string,
  relationType: "blocks" | "blocked-by",
  relatedIssueId: string,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<void> {
  await execLinearJson(buildIssueRelationAddArgs(issueId, relationType, relatedIssueId, env), env, signal);
}

export async function listLinearTeamMembers(
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearUser[]> {
  ensureLinearAuthConfigured(env);
  const payload = await execLinearJson<CliTeamMembersPayload>(buildTeamMembersArgs(env), env, signal);
  return normalizeTeamMembersPayload(payload);
}

export async function listOpenLinearIssues(
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue[]> {
  ensureLinearAuthConfigured(env);
  const teamKey = requireEnv(env, "LINEAR_TEAM_KEY");
  const payload = await execLinearJson<CliIssuePayload[]>(
    [
      "issue",
      "list",
      "--json",
      "--no-pager",
      "--limit",
      "0",
      "--sort",
      "manual",
      "--all-states",
      "--all-assignees",
      ...workspaceArgs(env),
      "--team",
      teamKey,
    ],
    env,
    signal,
  );

  const candidates = payload
    .map((issue) => normalizeLinearIssuePayload(issue))
    .filter(Boolean)
    .filter((issue) => {
      const stateName = issue?.state?.name?.toLowerCase() ?? "";
      return stateName !== "done" && stateName !== "completed" && stateName !== "canceled";
    }) as LinearIssue[];

  const enriched = await Promise.all(
    candidates.map(async (issue) => {
      const relationData = await loadIssueRelations(issue.identifier, env, signal).catch(() => ({
        relations: issue.relations ?? [],
        inverseRelations: issue.inverseRelations ?? [],
      }));
      return {
        ...issue,
        relations: relationData.relations,
        inverseRelations: relationData.inverseRelations,
      };
    }),
  );

  return enriched;
}

export async function listRiskyLinearIssues(
  _policy: RiskPolicy,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearIssue[]> {
  return listOpenLinearIssues(env, signal);
}
