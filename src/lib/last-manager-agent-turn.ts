import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadPaths } from "./thread-workspace.js";
import type { ManagerIntentReport, PendingClarificationDecisionReport, TaskExecutionDecisionReport } from "./manager-command-commit.js";

export interface LastManagerAgentTurn {
  recordedAt: string;
  intent?: ManagerIntentReport["intent"];
  queryKind?: ManagerIntentReport["queryKind"];
  queryScope?: ManagerIntentReport["queryScope"];
  confidence?: number;
  summary?: string;
  pendingClarificationDecision?: PendingClarificationDecisionReport["decision"];
  pendingClarificationPersistence?: PendingClarificationDecisionReport["persistence"];
  pendingClarificationDecisionSummary?: string;
  taskExecutionDecision?: TaskExecutionDecisionReport["decision"];
  taskExecutionTargetIssueId?: string;
  taskExecutionTargetIssueIdentifier?: string;
  taskExecutionSummary?: string;
  missingQuerySnapshot?: boolean;
}

function buildLastManagerAgentTurnPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "last-manager-agent-turn.json");
}

export async function loadLastManagerAgentTurn(
  paths: ThreadPaths,
): Promise<LastManagerAgentTurn | undefined> {
  try {
    const raw = await readFile(buildLastManagerAgentTurnPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.recordedAt !== "string") {
      return undefined;
    }
    return {
      recordedAt: parsed.recordedAt,
      intent: typeof parsed.intent === "string" ? parsed.intent as ManagerIntentReport["intent"] : undefined,
      queryKind: typeof parsed.queryKind === "string" ? parsed.queryKind as ManagerIntentReport["queryKind"] : undefined,
      queryScope: typeof parsed.queryScope === "string" ? parsed.queryScope as ManagerIntentReport["queryScope"] : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      pendingClarificationDecision: typeof parsed.pendingClarificationDecision === "string"
        ? parsed.pendingClarificationDecision as PendingClarificationDecisionReport["decision"]
        : undefined,
      pendingClarificationPersistence: typeof parsed.pendingClarificationPersistence === "string"
        ? parsed.pendingClarificationPersistence as PendingClarificationDecisionReport["persistence"]
        : undefined,
      pendingClarificationDecisionSummary: typeof parsed.pendingClarificationDecisionSummary === "string"
        ? parsed.pendingClarificationDecisionSummary
        : undefined,
      taskExecutionDecision: typeof parsed.taskExecutionDecision === "string"
        ? parsed.taskExecutionDecision as TaskExecutionDecisionReport["decision"]
        : undefined,
      taskExecutionTargetIssueId: typeof parsed.taskExecutionTargetIssueId === "string"
        ? parsed.taskExecutionTargetIssueId
        : undefined,
      taskExecutionTargetIssueIdentifier: typeof parsed.taskExecutionTargetIssueIdentifier === "string"
        ? parsed.taskExecutionTargetIssueIdentifier
        : undefined,
      taskExecutionSummary: typeof parsed.taskExecutionSummary === "string"
        ? parsed.taskExecutionSummary
        : undefined,
      missingQuerySnapshot: parsed.missingQuerySnapshot === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveLastManagerAgentTurn(
  paths: ThreadPaths,
  turn: LastManagerAgentTurn,
): Promise<void> {
  await writeFile(buildLastManagerAgentTurnPath(paths), `${JSON.stringify(turn, null, 2)}\n`, "utf8");
}

export async function clearLastManagerAgentTurn(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildLastManagerAgentTurnPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
