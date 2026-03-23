import { describe, expect, it } from "vitest";
import { mergeSystemReply, normalizeSystemReplyForSlack } from "../src/lib/system-slack-reply.js";

describe("system Slack reply helpers", () => {
  it("converts pipe tables into Slack-friendly bullets", () => {
    const result = normalizeSystemReplyForSlack([
      "夕方時点で確認してほしい点があります。",
      "| ID | タイトル | 期限 | 状態 |",
      "|---|---|---|---|",
      "| AIC-39 | AIマネージャーを実用レベルへ引き上げる | 2026-03-26（3日後） | Backlog |",
    ].join("\n"));

    expect(result).not.toContain("| ID |");
    expect(result).not.toContain("|---|");
    expect(result).toContain("- AIC-39 AIマネージャーを実用レベルへ引き上げる / 期限: 2026-03-26（3日後） / 状態: Backlog");
  });

  it("suppresses duplicate follow-up system logs when the agent already said it", () => {
    const result = mergeSystemReply({
      agentReply: "AIC-39 への確認を送りました。",
      commitSummaries: ["AIC-39 の follow-up を作成しました。"],
      commitRejections: [],
    });

    expect(result).toContain("AIC-39 への確認を送りました。");
    expect(result).not.toContain("system log");
    expect(result).not.toContain("follow-up を作成しました");
  });

  it("keeps non-duplicate commit summaries as quoted system logs", () => {
    const result = mergeSystemReply({
      agentReply: "夕方時点で確認してほしい点があります。",
      commitSummaries: ["AIC-39 の follow-up を作成しました。"],
      commitRejections: [],
    });

    expect(result).toContain("夕方時点で確認してほしい点があります。");
    expect(result).toContain("> system log: AIC-39 の follow-up を作成しました。");
  });
});
