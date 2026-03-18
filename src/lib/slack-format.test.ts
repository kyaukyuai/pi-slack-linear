import { describe, expect, it } from "vitest";
import { formatSlackMessageText } from "./slack-format.js";

describe("formatSlackMessageText", () => {
  it("converts standard markdown emphasis to Slack mrkdwn", () => {
    const result = formatSlackMessageText("**bold** *italic* ~~strike~~");

    expect(result).toContain("*bold*");
    expect(result).toContain("_italic_");
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
});
