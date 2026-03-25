import { describe, expect, it } from "vitest";
import { extractLatestAssistantText, selectFinalAssistantText } from "../src/runtime/assistant-text.js";

describe("assistant text selection", () => {
  it("prefers the latest assistant message over accumulated deltas", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "AIC-39 が明日期限で最重要。" },
        ],
      },
      {
        role: "tool",
        content: "tool result",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "おはようございます。本日（3/25）のレビューです。" },
        ],
      },
    ];

    expect(selectFinalAssistantText(messages, [
      "AIC-39 が明日期限で最重要。",
      "おはようございます。本日（3/25）のレビューです。",
    ])).toBe("おはようございます。本日（3/25）のレビューです。");
  });

  it("falls back to deltas when no assistant message text is available", () => {
    expect(selectFinalAssistantText([], ["考え中...", "最終返信"])).toBe("考え中...最終返信");
  });

  it("extracts the latest non-empty assistant text", () => {
    const messages = [
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "text", text: "最終返信" }] },
    ];

    expect(extractLatestAssistantText(messages)).toBe("最終返信");
  });
});
