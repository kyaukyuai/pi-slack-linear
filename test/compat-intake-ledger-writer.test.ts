import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { createCompatIntakeLedgerWriter } from "../src/state/compat/intake-ledger-writer.js";
import { createFileBackedManagerRepositories } from "../src/state/repositories/file-backed-manager-repositories.js";

describe("compat intake ledger writer", () => {
  it("persists compatibility entries without exposing intake schema to orchestrators", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "pi-slack-linear-compat-intake-"));
    const repositories = createFileBackedManagerRepositories(buildSystemPaths(workspaceDir));
    const writer = createCompatIntakeLedgerWriter(repositories.compatIntake, {
      fingerprintText: (text) => text.trim().toLowerCase().replace(/\s+/g, "-"),
      nowIso: (now) => now.toISOString(),
    });
    const now = new Date("2026-03-19T01:00:00.000Z");

    await writer.writeClarificationRequested({
      message: {
        channelId: "C123",
        rootThreadTs: "thread-1",
        messageTs: "msg-1",
        text: "来週のリリースに向けた対応を進めておいて",
      },
      messageFingerprint: "release-work",
      clarificationQuestion: "期限と分けたい作業を教えてください。",
      clarificationReasons: ["due_date", "execution_plan"],
      originalText: "来週のリリースに向けた対応を進めておいて",
      now,
    });

    await writer.patchIssueStatus({
      message: {
        channelId: "C123",
        rootThreadTs: "thread-1",
        messageTs: "msg-2",
        text: "進捗です。確認を始めました",
      },
      status: "progressed",
      lastResolvedIssueId: "AIC-123",
      now: new Date("2026-03-19T01:05:00.000Z"),
    });

    await expect(repositories.compatIntake.load()).resolves.toEqual([
      expect.objectContaining({
        sourceChannelId: "C123",
        sourceThreadTs: "thread-1",
        status: "progressed",
        clarificationQuestion: "期限と分けたい作業を教えてください。",
        clarificationReasons: ["due_date", "execution_plan"],
        lastResolvedIssueId: "AIC-123",
      }),
    ]);
  });
});
