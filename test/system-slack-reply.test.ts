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

  it("keeps a quoted system log when the summary carries a link the agent reply does not include", () => {
    const result = mergeSystemReply({
      agentReply: "アジェンダを作成しました。内容を確認してください。",
      commitSummaries: ["Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>"],
      commitRejections: [],
    });

    expect(result).toContain("アジェンダを作成しました。内容を確認してください。");
    expect(result).toContain("> system log: Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>");
  });

  it("dedupes repeated improvement intro sentences in system replies", () => {
    const result = normalizeSystemReplyForSlack([
      "状況が改善しています。AIC-39 は In Review に進みました。おはようございます。本日（3/24）のレビューです。昨日から状況が前進しています。",
      "- <https://linear.app/kyaukyuai/issue/AIC-39|AIC-39> AIマネージャーを実用レベルへ引き上げる / 期限: 2026-03-26（2日後） / 状態: In Review",
    ].join("\n"));

    expect(result).toContain("状況が改善しています。");
    expect(result).toContain("おはようございます。本日（3/24）のレビューです。");
    expect(result).not.toContain("昨日から状況が前進しています。");
  });

  it("inserts paragraph breaks around inline section headings", () => {
    const result = normalizeSystemReplyForSlack([
      "AIC-39 は Done になっています。お疲れ様でした。*本日追加の新タスク群 (AIC-44〜51)* 今日の議事録から8タスクが作成され、全て Backlog・期限未設定。",
      "アクション提案: AIC-44 に着手予定・期限設定の確認を送信。",
      "引き続き進行中 AIC-38（OPT社招待）: 期限 3日後(3/27)、昨日 progress 更新あり、特に問題なし。",
    ].join("\n"));

    expect(result).toContain("お疲れ様でした。\n\n*本日追加の新タスク群 (AIC-44〜51)*\n今日の議事録から8タスクが作成され");
    expect(result).toContain("期限未設定。\n\nアクション提案:");
    expect(result).toContain("確認を送信。\n\n引き続き進行中");
  });

  it("preserves quoted heartbeat detail blocks after the title", () => {
    const result = normalizeSystemReplyForSlack([
      "**【AIC-38】期限2日後・未着手**",
      "",
      "> **OPT社の社内チャネルへの招待依頼**（担当: y.kakui）",
      "> 優先度: High ／ 期限: **2日後 (2026-03-27)** ／ 状態: Backlog",
      "",
      "期限が迫っています。対応状況をこのスレッドに返信してください。",
      "例：「対応済み」「対応中」「ブロック中（理由）」",
    ].join("\n"));

    expect(result).toContain("**【AIC-38】期限2日後・未着手**\n\n> **OPT社の社内チャネルへの招待依頼**（担当: y.kakui）");
    expect(result).toContain("> 優先度: High ／ 期限: **2日後 (2026-03-27)** ／ 状態: Backlog");
    expect(result).toContain("\n\n期限が迫っています。対応状況をこのスレッドに返信してください。");
  });
});
