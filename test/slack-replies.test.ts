import { describe, expect, it, vi } from "vitest";
import { postSlackProcessingNotice, sendSlackReply } from "../src/lib/slack-replies.js";

describe("slack reply helpers", () => {
  it("posts a processing notice in thread", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "123.456" });
    const update = vi.fn();
    const webClient = {
      chat: { postMessage, update },
    } as never;

    const ts = await postSlackProcessingNotice(webClient, {
      channel: "C123",
      threadTs: "111.222",
    });

    expect(ts).toBe("123.456");
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      text: "考え中...",
    });
  });

  it("updates an existing placeholder when ts is provided", async () => {
    const postMessage = vi.fn();
    const update = vi.fn().mockResolvedValue({});
    const webClient = {
      chat: { postMessage, update },
    } as never;

    const text = await sendSlackReply(webClient, {
      channel: "C123",
      threadTs: "111.222",
      reply: "AIC-39 を確認してください。",
      linearWorkspace: "kyaukyuai",
      updateTs: "123.456",
    });

    expect(text).toBe("AIC-39 を確認してください。");
    expect(update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "123.456",
      text: "AIC-39 を確認してください。",
      blocks: expect.any(Array),
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("falls back to posting a new reply when update fails", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "123.789" });
    const update = vi.fn().mockRejectedValue(new Error("message_not_found"));
    const webClient = {
      chat: { postMessage, update },
    } as never;

    await sendSlackReply(webClient, {
      channel: "C123",
      threadTs: "111.222",
      reply: "AIC-39 を確認してください。",
      linearWorkspace: "kyaukyuai",
      updateTs: "123.456",
    });

    expect(update).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      text: "AIC-39 を確認してください。",
      blocks: expect.any(Array),
    });
  });
});
