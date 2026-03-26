import type { AppConfig } from "./config.js";
import {
  getLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
} from "./linear.js";
import { analyzeOwnerMap, type OwnerMapDiagnostics } from "./owner-map-diagnostics.js";
import { loadLastManagerAgentTurn, type LastManagerAgentTurn } from "./last-manager-agent-turn.js";
import { loadPendingManagerClarification, type PendingManagerClarification } from "./pending-manager-clarification.js";
import { loadThreadQueryContinuation, type ThreadQueryContinuation } from "./query-continuation.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import {
  buildSystemPaths,
  inspectSystemStateFiles,
  readWorkspaceMemory,
  type SystemStateFileClassification,
  type SystemStateFileStatus,
  type SystemStateOperatorAction,
  type SystemStateWritePolicy,
} from "./system-workspace.js";
import {
  analyzeWorkspaceMemory,
  type WorkspaceMemoryCoverageDiagnostics,
} from "./workspace-memory-diagnostics.js";
import type { FollowupLedgerEntry } from "../state/manager-state-contract.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import {
  getIssueContext,
  getLatestIssueSource,
  getThreadPlanningContext,
  listAwaitingFollowups,
  type WorkgraphIssueContext,
  type WorkgraphIssueSource,
  type WorkgraphThreadPlanningContext,
} from "../state/workgraph/queries.js";
import { buildThreadPaths } from "./thread-workspace.js";

export interface ManagerThreadDiagnostics {
  channelId: string;
  rootThreadTs: string;
  threadKey: string;
  planningContext?: WorkgraphThreadPlanningContext;
  awaitingFollowups: WorkgraphIssueContext[];
  lastQueryContext?: ThreadQueryContinuation;
  pendingClarification?: PendingManagerClarification;
  lastAgentTurn?: LastManagerAgentTurn;
  slackThreadContext: Awaited<ReturnType<typeof getSlackThreadContext>>;
  recentChannelContext: Awaited<ReturnType<typeof getRecentChannelContext>>;
  ownerMapDiagnostics: OwnerMapDiagnostics;
}

export interface ManagerIssueDiagnostics {
  issueId: string;
  issueContext?: WorkgraphIssueContext;
  latestSource?: WorkgraphIssueSource;
  followup?: FollowupLedgerEntry;
  slackThreadContext?: Awaited<ReturnType<typeof getSlackThreadContext>>;
  linearIssue?: LinearIssue | null;
}

export interface ManagerStateFilesDiagnostics {
  workspaceDir: string;
  systemRoot: string;
  files: SystemStateFileStatus[];
  classificationSummary: Record<SystemStateFileClassification, string[]>;
  operatorActionSummary: {
    editOk: string[];
    inspectOnly: string[];
    doNotEdit: string[];
  };
  writePolicySummary: Record<SystemStateWritePolicy, string[]>;
  notes: {
    editable: string;
    internal: string;
    derived: string;
  };
  writePolicyNotes: {
    humanPrimary: string;
    silentAutoUpdate: string;
    explicitSlackUpdate: string;
    managerCommitOnly: string;
    systemMaintained: string;
    rebuildOnly: string;
  };
}

export interface ManagerWorkspaceMemoryDiagnostics extends WorkspaceMemoryCoverageDiagnostics {
  workspaceDir: string;
  memoryFile: string;
}

async function loadLinearIssueBestEffort(
  issueId: string,
  env: LinearCommandEnv,
): Promise<LinearIssue | null> {
  try {
    return await getLinearIssue(issueId, env, undefined, { includeComments: true });
  } catch {
    return null;
  }
}

export async function buildManagerThreadDiagnostics(args: {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "ownerMap" | "workgraph">;
  channelId: string;
  rootThreadTs: string;
}): Promise<ManagerThreadDiagnostics> {
  const threadKey = buildWorkgraphThreadKey(args.channelId, args.rootThreadTs);
  const threadPaths = buildThreadPaths(args.config.workspaceDir, args.channelId, args.rootThreadTs);
  const [planningContext, awaitingFollowups, slackThreadContext, recentChannelContext, ownerMap, lastQueryContext, pendingClarification, lastAgentTurn] = await Promise.all([
    getThreadPlanningContext(args.repositories.workgraph, threadKey),
    listAwaitingFollowups(args.repositories.workgraph),
    getSlackThreadContext(args.config.workspaceDir, args.channelId, args.rootThreadTs, 12),
    getRecentChannelContext(args.config.workspaceDir, args.channelId, 5, 8),
    args.repositories.ownerMap.load(),
    loadThreadQueryContinuation(threadPaths),
    loadPendingManagerClarification(threadPaths),
    loadLastManagerAgentTurn(threadPaths),
  ]);

  const relatedIssueIds = new Set<string>([
    planningContext?.parentIssue?.issueId,
    ...(planningContext?.childIssues.map((issue) => issue.issueId) ?? []),
    ...(planningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
    planningContext?.latestResolvedIssue?.issueId,
  ].filter(Boolean) as string[]);

  return {
    channelId: args.channelId,
    rootThreadTs: args.rootThreadTs,
    threadKey,
    planningContext,
    awaitingFollowups: awaitingFollowups.filter((issue) => relatedIssueIds.has(issue.issueId)),
    lastQueryContext,
    pendingClarification,
    lastAgentTurn,
    slackThreadContext,
    recentChannelContext,
    ownerMapDiagnostics: analyzeOwnerMap(ownerMap),
  };
}

export async function buildManagerIssueDiagnostics(args: {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "followups" | "workgraph">;
  issueId: string;
  env: LinearCommandEnv;
}): Promise<ManagerIssueDiagnostics> {
  const [issueContext, latestSource, followups, linearIssue] = await Promise.all([
    getIssueContext(args.repositories.workgraph, args.issueId),
    getLatestIssueSource(args.repositories.workgraph, args.issueId),
    args.repositories.followups.load(),
    loadLinearIssueBestEffort(args.issueId, args.env),
  ]);

  const followup = followups.find((entry) => entry.issueId === args.issueId);
  const slackThreadContext = latestSource
    ? await getSlackThreadContext(
      args.config.workspaceDir,
      latestSource.channelId,
      latestSource.rootThreadTs,
      12,
    ).catch(() => undefined)
    : undefined;

  return {
    issueId: args.issueId,
    issueContext,
    latestSource,
    followup,
    slackThreadContext,
    linearIssue,
  };
}

function summarizeByClassification(
  files: SystemStateFileStatus[],
  classification: SystemStateFileClassification,
): string[] {
  return files
    .filter((file) => file.classification === classification)
    .map((file) => file.relativePath);
}

function summarizeByOperatorAction(
  files: SystemStateFileStatus[],
  action: SystemStateOperatorAction,
): string[] {
  return files
    .filter((file) => file.operatorAction === action)
    .map((file) => file.relativePath);
}

function summarizeByWritePolicy(
  files: SystemStateFileStatus[],
  writePolicy: SystemStateWritePolicy,
): string[] {
  return files
    .filter((file) => file.writePolicy === writePolicy)
    .map((file) => file.relativePath);
}

export async function buildManagerStateFileDiagnostics(args: {
  workspaceDir: string;
}): Promise<ManagerStateFilesDiagnostics> {
  const systemPaths = buildSystemPaths(args.workspaceDir);
  const files = await inspectSystemStateFiles(systemPaths);

  return {
    workspaceDir: args.workspaceDir,
    systemRoot: systemPaths.rootDir,
    files,
    classificationSummary: {
      editable: summarizeByClassification(files, "editable"),
      internal: summarizeByClassification(files, "internal"),
      derived: summarizeByClassification(files, "derived"),
    },
    operatorActionSummary: {
      editOk: summarizeByOperatorAction(files, "edit-ok"),
      inspectOnly: summarizeByOperatorAction(files, "inspect-only"),
      doNotEdit: summarizeByOperatorAction(files, "do-not-edit"),
    },
    writePolicySummary: {
      "human-primary": summarizeByWritePolicy(files, "human-primary"),
      "silent-auto-update": summarizeByWritePolicy(files, "silent-auto-update"),
      "explicit-slack-update": summarizeByWritePolicy(files, "explicit-slack-update"),
      "manager-commit-only": summarizeByWritePolicy(files, "manager-commit-only"),
      "system-maintained": summarizeByWritePolicy(files, "system-maintained"),
      "rebuild-only": summarizeByWritePolicy(files, "rebuild-only"),
    },
    notes: {
      editable: "Operator-managed runtime config or prompt slots. Direct edits are expected.",
      internal: "System-managed ledgers or registries. Inspect them when needed, but avoid hand edits.",
      derived: "Generated execution state. Rebuild or recover it with tooling instead of editing by hand.",
    },
    writePolicyNotes: {
      humanPrimary: "Primarily edited by humans. The system should not rewrite it silently.",
      silentAutoUpdate: "The system may update it automatically when confidence is high.",
      explicitSlackUpdate: "Silent updates are disabled. Change it only through an explicit Slack request plus manager commit.",
      managerCommitOnly: "Automation should update it only through typed proposals and manager commit logic.",
      systemMaintained: "The runtime owns writes directly as part of normal execution.",
      rebuildOnly: "Treat it as generated state. Rebuild or recover it instead of editing.",
    },
  };
}

export async function buildManagerWorkspaceMemoryDiagnostics(args: {
  workspaceDir: string;
}): Promise<ManagerWorkspaceMemoryDiagnostics> {
  const systemPaths = buildSystemPaths(args.workspaceDir);
  const workspaceMemory = await readWorkspaceMemory(systemPaths);

  return {
    workspaceDir: args.workspaceDir,
    memoryFile: systemPaths.memoryFile,
    ...analyzeWorkspaceMemory(workspaceMemory),
  };
}
