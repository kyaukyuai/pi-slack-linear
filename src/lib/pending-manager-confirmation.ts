import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  managerCommandProposalSchema,
  type ManagerCommandProposal,
} from "./manager-command-commit.js";
import type { ThreadPaths } from "./thread-workspace.js";

export interface PendingManagerConfirmation {
  kind: "owner-map";
  originalUserMessage: string;
  proposals: Array<Extract<ManagerCommandProposal, { commandType: "update_owner_map" }>>;
  previewSummaryLines: string[];
  recordedAt: string;
}

const CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

const pendingManagerConfirmationSchema = z.object({
  kind: z.literal("owner-map"),
  originalUserMessage: z.string(),
  proposals: z.array(managerCommandProposalSchema).transform((proposals, ctx) => {
    const ownerMapProposals = proposals.filter((proposal): proposal is Extract<ManagerCommandProposal, { commandType: "update_owner_map" }> => (
      proposal.commandType === "update_owner_map"
    ));
    if (ownerMapProposals.length !== proposals.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposals"],
        message: "pending manager confirmation only supports update_owner_map proposals",
      });
      return z.NEVER;
    }
    return ownerMapProposals;
  }),
  previewSummaryLines: z.array(z.string()),
  recordedAt: z.string(),
});

function buildPendingManagerConfirmationPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "pending-manager-confirmation.json");
}

export function parsePendingManagerConfirmationDecision(text: string): "confirm" | "cancel" | undefined {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？、,\s]/g, "");
  if (!normalized) return undefined;
  if (normalized === "はい"
    || normalized === "お願いします"
    || normalized === "実行して"
    || normalized === "適用して"
    || normalized === "confirm"
    || normalized === "ok"
    || normalized === "はいお願いします") {
    return "confirm";
  }
  if (normalized === "キャンセル"
    || normalized === "やめて"
    || normalized === "取り消して"
    || normalized === "no") {
    return "cancel";
  }
  return undefined;
}

export async function loadPendingManagerConfirmation(
  paths: ThreadPaths,
  now = new Date(),
): Promise<PendingManagerConfirmation | undefined> {
  try {
    const raw = await readFile(buildPendingManagerConfirmationPath(paths), "utf8");
    const parsed = pendingManagerConfirmationSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return undefined;
    }

    const recordedAt = Date.parse(parsed.data.recordedAt);
    if (Number.isNaN(recordedAt) || now.getTime() - recordedAt > CONFIRMATION_EXPIRY_MS) {
      await clearPendingManagerConfirmation(paths);
      return undefined;
    }

    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function savePendingManagerConfirmation(
  paths: ThreadPaths,
  confirmation: PendingManagerConfirmation,
): Promise<void> {
  await mkdir(dirname(buildPendingManagerConfirmationPath(paths)), { recursive: true });
  await writeFile(
    buildPendingManagerConfirmationPath(paths),
    `${JSON.stringify(confirmation, null, 2)}\n`,
    "utf8",
  );
}

export async function clearPendingManagerConfirmation(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildPendingManagerConfirmationPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
