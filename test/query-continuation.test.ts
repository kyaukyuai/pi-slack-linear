import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearThreadQueryContinuation,
  extractIssueIdsFromText,
  loadThreadQueryContinuation,
  saveThreadQueryContinuation,
  summarizeSlackReply,
} from "../src/lib/query-continuation.js";
import { buildThreadPaths, ensureThreadWorkspace } from "../src/lib/thread-workspace.js";

describe("thread query continuation", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
    workspaces.length = 0;
  });

  it("persists and loads the last query continuation context", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "query-continuation-"));
    workspaces.push(workspaceDir);
    const paths = buildThreadPaths(workspaceDir, "C123", "1742198400.123456");
    await ensureThreadWorkspace(paths);

    await saveThreadQueryContinuation(paths, {
      kind: "what-should-i-do",
      scope: "team",
      userMessage: "今日やるべきタスクある？",
      replySummary: "今日まず見るなら AIC-38 です。",
      issueIds: ["AIC-38"],
      shownIssueIds: ["AIC-38"],
      remainingIssueIds: ["AIC-39"],
      totalItemCount: 2,
      referenceItems: [
        {
          id: "notion-page-1",
          title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
          url: "https://www.notion.so/notion-page-1",
          source: "notion",
        },
      ],
      recordedAt: "2026-03-23T00:00:00.000Z",
    });

    await expect(loadThreadQueryContinuation(paths)).resolves.toEqual({
      kind: "what-should-i-do",
      scope: "team",
      userMessage: "今日やるべきタスクある？",
      replySummary: "今日まず見るなら AIC-38 です。",
      issueIds: ["AIC-38"],
      shownIssueIds: ["AIC-38"],
      remainingIssueIds: ["AIC-39"],
      totalItemCount: 2,
      referenceItems: [
        {
          id: "notion-page-1",
          title: "2026.03.10 | AIクローンプラットフォーム 初回会議共有資料",
          url: "https://www.notion.so/notion-page-1",
          source: "notion",
        },
      ],
      recordedAt: "2026-03-23T00:00:00.000Z",
    });

    await clearThreadQueryContinuation(paths);
    await expect(loadThreadQueryContinuation(paths)).resolves.toBeUndefined();
  });

  it("extracts issue ids and shortens Slack replies for stored context", () => {
    expect(extractIssueIdsFromText("AIC-38 を見て、次は AIC-39 も確認してください。AIC-38 は継続です。")).toEqual(["AIC-38", "AIC-39"]);
    expect(summarizeSlackReply("  今日まず見るなら AIC-38 を確認してください。   他に動いている task はありません。  ", 40)).toBe(
      "今日まず見るなら AIC-38 を確認してください。 他に動いている ta...",
    );
  });
});
