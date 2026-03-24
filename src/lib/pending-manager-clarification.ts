import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadPaths } from "./thread-workspace.js";

export type PendingManagerClarificationIntent =
  | "create_work"
  | "create_schedule"
  | "run_schedule"
  | "update_progress"
  | "update_completed"
  | "update_blocked"
  | "update_schedule"
  | "delete_schedule"
  | "followup_resolution";

export interface PendingManagerClarification {
  intent: PendingManagerClarificationIntent;
  originalUserMessage: string;
  lastUserMessage: string;
  clarificationReply: string;
  missingDecisionSummary?: string;
  threadParentIssueId?: string;
  relatedIssueIds: string[];
  recordedAt: string;
}

const CLARIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

function buildPendingManagerClarificationPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "pending-manager-clarification.json");
}

function isPendingManagerClarificationIntent(value: unknown): value is PendingManagerClarificationIntent {
  return value === "create_work"
    || value === "create_schedule"
    || value === "run_schedule"
    || value === "update_progress"
    || value === "update_completed"
    || value === "update_blocked"
    || value === "update_schedule"
    || value === "delete_schedule"
    || value === "followup_resolution";
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function isPendingManagerClarificationContinuation(text: string): boolean {
  return /(という意図です|そういう意味です|つまり|そうではなく|補足すると|言い換えると|意図としては)/.test(text);
}

export function isPendingManagerClarificationStatusQuestion(text: string): boolean {
  return /(どういう状況|何が起きて|どういう意味|なぜそうなっ|なんでそうなっ)/.test(text);
}

export function combinePendingManagerClarificationRequest(
  clarification: PendingManagerClarification,
  latestUserMessage: string,
): string {
  const addition = latestUserMessage.trim();
  if (!addition) {
    return clarification.originalUserMessage;
  }
  if (addition === clarification.originalUserMessage.trim()) {
    return clarification.originalUserMessage;
  }
  return `${clarification.originalUserMessage}\n\n補足:\n${addition}`.trim();
}

export async function loadPendingManagerClarification(
  paths: ThreadPaths,
  now = new Date(),
): Promise<PendingManagerClarification | undefined> {
  try {
    const raw = await readFile(buildPendingManagerClarificationPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isPendingManagerClarificationIntent(parsed.intent)) {
      return undefined;
    }
    if (
      typeof parsed.originalUserMessage !== "string"
      || typeof parsed.lastUserMessage !== "string"
      || typeof parsed.clarificationReply !== "string"
      || typeof parsed.recordedAt !== "string"
    ) {
      return undefined;
    }

    const recordedAt = Date.parse(parsed.recordedAt);
    if (Number.isNaN(recordedAt) || now.getTime() - recordedAt > CLARIFICATION_EXPIRY_MS) {
      await clearPendingManagerClarification(paths);
      return undefined;
    }

    return {
      intent: parsed.intent,
      originalUserMessage: parsed.originalUserMessage,
      lastUserMessage: parsed.lastUserMessage,
      clarificationReply: parsed.clarificationReply,
      missingDecisionSummary: typeof parsed.missingDecisionSummary === "string" ? parsed.missingDecisionSummary : undefined,
      threadParentIssueId: typeof parsed.threadParentIssueId === "string" ? parsed.threadParentIssueId : undefined,
      relatedIssueIds: normalizeStringList(parsed.relatedIssueIds),
      recordedAt: parsed.recordedAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function savePendingManagerClarification(
  paths: ThreadPaths,
  clarification: PendingManagerClarification,
): Promise<void> {
  await writeFile(
    buildPendingManagerClarificationPath(paths),
    `${JSON.stringify(clarification, null, 2)}\n`,
    "utf8",
  );
}

export async function clearPendingManagerClarification(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildPendingManagerClarificationPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
