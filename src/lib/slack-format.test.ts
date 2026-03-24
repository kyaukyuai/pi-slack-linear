import { describe, expect, it } from "vitest";
import { buildSlackMessagePayload, formatSlackMessageText } from "./slack-format.js";

describe("formatSlackMessageText", () => {
  it("converts standard markdown emphasis to Slack mrkdwn", () => {
    const result = formatSlackMessageText("**bold** *italic* ~~strike~~");

    expect(result).toContain("*bold*");
    expect(result).toContain("*italic*");
    expect(result).toContain("~strike~");
  });

  it("converts markdown links and headings", () => {
    const result = formatSlackMessageText("# Header\n[Google](https://google.com)");

    expect(result).toContain("*Header*");
    expect(result).toContain("<https://google.com|Google>");
  });

  it("keeps Slack-compatible emoji aliases while removing raw double-asterisk markup", () => {
    const result = formatSlackMessageText([
      "> URLのスレッドを確認しますね。少々お待ちください。申し訳ありません、そのSlackチャンネル（`C06KC7MA0G5`）のスレッドにはアクセス権がなく、内容を取得できませんでした。",
      "",
      ":clipboard: **次のいずれかをお知らせいただけますか？**",
      "",
      "- スレッドの内容や対応したいタスクの概要を、こちらのチャットに貼り付けていただく",
    ].join("\n"));

    expect(result).toContain(":clipboard:");
    expect(result).toContain("*次のいずれかをお知らせいただけますか？*");
    expect(result).not.toContain("**次のいずれかをお知らせいただけますか？**");
  });

  it("builds mrkdwn blocks and plain-text fallback for public posts", () => {
    const payload = buildSlackMessagePayload([
      "週次レビューの結果、注意が必要なissueが3件あります。- *AIC-38*「OPT社の社内チャネルへの招待依頼」— 3/19期限で*期限超過*。",
      "",
      "- *AIC-39*「AIマネージャーを実用レベルへ引き上げる」— 3/26期限。",
    ].join("\n"), { linearWorkspace: "kyaukyuai" });

    expect(payload.text).not.toContain("*AIC-38*");
    expect(payload.text).toContain("AIC-38");
    expect(payload.blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "週次レビューの結果、注意が必要なissueが3件あります。",
      },
    });
    expect(payload.blocks[1]).toMatchObject({
      type: "rich_text",
      elements: [{
        type: "rich_text_list",
        style: "bullet",
      }],
    });
    const richList = payload.blocks[1] as { elements: Array<{ elements: Array<{ elements: Array<{ type: string; url?: string; text?: string }> }> }> };
    expect(richList.elements[0]?.elements[0]?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "link",
          url: "https://linear.app/kyaukyuai/issue/AIC-38",
          text: "AIC-38",
        }),
      ]),
    );
  });

  it("keeps quoted system logs as mrkdwn lines and strips the marker from plain-text fallback", () => {
    const payload = buildSlackMessagePayload([
      "アジェンダを作成しました。",
      "",
      "> system log: Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>",
    ].join("\n"));

    expect(payload.text).toContain("system log: Notion agenda created: 2026.03.26 | AIクローンプラットフォーム Vol.1");
    expect(payload.text).not.toContain("> system log");
    expect(payload.blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "アジェンダを作成しました。",
      },
    });
    expect(payload.blocks[1]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "> system log: Notion agenda created: <https://www.notion.so/page-1|2026.03.26 | AIクローンプラットフォーム Vol.1>",
      },
    });
  });

  it("preserves paragraph breaks between mutation summary, system log, and follow-up guidance", () => {
    const payload = buildSlackMessagePayload([
      "「webhook の動作確認」タスクを作成します。担当者は未設定にしています。",
      "",
      "> system log: この依頼は Linear に登録しておきました。 対象は <https://linear.app/kyaukyuai/issue/AIC-52|AIC-52> webhook の動作確認 です。",
      "",
      "この thread で進捗・完了・blocked を続けてください。",
      "",
      "担当が未定義だった task は、いったん kyaukyuai に寄せています。",
    ].join("\n"));

    expect(payload.blocks[0]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "「webhook の動作確認」タスクを作成します。担当者は未設定にしています。" },
    });
    expect(payload.blocks[1]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "> system log: この依頼は Linear に登録しておきました。 対象は <https://linear.app/kyaukyuai/issue/AIC-52|AIC-52> webhook の動作確認 です。" },
    });
    expect(payload.blocks[2]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "この thread で進捗・完了・blocked を続けてください。" },
    });
    expect(payload.blocks[3]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "担当が未定義だった task は、いったん kyaukyuai に寄せています。" },
    });
  });

  it("renders inline code inside bullet lists without leaving literal backticks", () => {
    const payload = buildSlackMessagePayload([
      "現在5件のスケジュールが登録されています。",
      "",
      "- `heartbeat` — 30分ごと（有効）",
      "- `weekly-notion-agenda-ai-clone` — 毎週木曜 09:00（有効、前回実行: 今日 ok）",
    ].join("\n"));

    expect(payload.text).not.toContain("`heartbeat`");
    expect(payload.text).toContain("heartbeat");
    expect(payload.blocks[1]).toMatchObject({
      type: "rich_text",
      elements: [{
        type: "rich_text_list",
        style: "bullet",
      }],
    });
    const richList = payload.blocks[1] as {
      elements: Array<{
        elements: Array<{
          elements: Array<{ type: string; text?: string; style?: { code?: boolean } }>;
        }>;
      }>;
    };
    expect(richList.elements[0]?.elements[0]?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "heartbeat",
          style: expect.objectContaining({ code: true }),
        }),
      ]),
    );
  });
});
