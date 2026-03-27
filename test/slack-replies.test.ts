import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlackReplyStreamController,
  postSlackMentionMessage,
  postSlackProcessingNotice,
  sendSlackReply,
} from "../src/lib/slack-replies.js";

describe("slack reply helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("starts and stops a reply stream for read-only replies", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn().mockResolvedValue({ ts: "placeholder.123" });
    const update = vi.fn();
    const deleteMessage = vi.fn().mockResolvedValue({});
    const startStream = vi.fn().mockResolvedValue({ ts: "stream.123" });
    const appendStream = vi.fn().mockResolvedValue({});
    const stopStream = vi.fn().mockResolvedValue({});
    const webClient = {
      chat: { postMessage, update, delete: deleteMessage, startStream, appendStream, stopStream },
    } as never;

    const controller = createSlackReplyStreamController(webClient, {
      channel: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      linearWorkspace: "kyaukyuai",
    });

    await controller.enableStreaming();
    controller.pushTextDelta("こんにちは");

    const text = await controller.finalizeReply("こんにちは");

    expect(text).toBe("こんにちは");
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      text: "考え中...",
    });
    expect(deleteMessage).toHaveBeenCalledWith({
      channel: "C123",
      ts: "placeholder.123",
    });
    expect(startStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      recipient_user_id: "U123",
      recipient_team_id: "T123",
      markdown_text: "こんにちは",
    });
    expect(stopStream).toHaveBeenCalledWith({
      channel: "C123",
      ts: "stream.123",
      markdown_text: undefined,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("appends buffered deltas on a throttle while streaming", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn().mockResolvedValue({ ts: "placeholder.456" });
    const update = vi.fn();
    const deleteMessage = vi.fn().mockResolvedValue({});
    const startStream = vi.fn().mockResolvedValue({ ts: "stream.456" });
    const appendStream = vi.fn().mockResolvedValue({});
    const stopStream = vi.fn().mockResolvedValue({});
    const webClient = {
      chat: { postMessage, update, delete: deleteMessage, startStream, appendStream, stopStream },
    } as never;

    const controller = createSlackReplyStreamController(webClient, {
      channel: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      linearWorkspace: "kyaukyuai",
    });

    await controller.enableStreaming();
    controller.pushTextDelta("こんにちは");
    await vi.advanceTimersByTimeAsync(250);

    controller.pushTextDelta("。よろしくお願いします。");
    await vi.advanceTimersByTimeAsync(250);

    const text = await controller.finalizeReply("こんにちは。よろしくお願いします。");

    expect(text).toBe("こんにちは。よろしくお願いします。");
    expect(deleteMessage).toHaveBeenCalledWith({
      channel: "C123",
      ts: "placeholder.456",
    });
    expect(startStream).toHaveBeenCalledTimes(1);
    expect(appendStream).toHaveBeenCalledWith({
      channel: "C123",
      ts: "stream.456",
      markdown_text: "。よろしくお願いします。",
    });
    expect(stopStream).toHaveBeenCalledWith({
      channel: "C123",
      ts: "stream.456",
      markdown_text: undefined,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("posts the processing notice immediately when the controller is created", () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "123.456" });
    const update = vi.fn();
    const webClient = {
      chat: { postMessage, update, delete: vi.fn(), startStream: vi.fn(), appendStream: vi.fn(), stopStream: vi.fn() },
    } as never;

    createSlackReplyStreamController(webClient, {
      channel: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      linearWorkspace: "kyaukyuai",
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      text: "考え中...",
    });
  });

  it("falls back to placeholder plus update when placeholder delete fails", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "123.456" });
    const update = vi.fn().mockResolvedValue({});
    const deleteMessage = vi.fn().mockRejectedValue(new Error("cant_delete"));
    const startStream = vi.fn();
    const appendStream = vi.fn();
    const stopStream = vi.fn();
    const webClient = {
      chat: { postMessage, update, delete: deleteMessage, startStream, appendStream, stopStream },
    } as never;

    const controller = createSlackReplyStreamController(webClient, {
      channel: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      linearWorkspace: "kyaukyuai",
    });

    await controller.enableStreaming();
    controller.pushTextDelta("こんにちは");

    const text = await controller.finalizeReply("こんにちは");

    expect(text).toBe("こんにちは");
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      text: "考え中...",
    });
    expect(update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "123.456",
      text: "こんにちは",
      blocks: expect.any(Array),
    });
    expect(startStream).not.toHaveBeenCalled();
    expect(stopStream).not.toHaveBeenCalled();
  });

  it("reposts the placeholder when stream setup fails after delete", async () => {
    const postMessage = vi.fn()
      .mockResolvedValueOnce({ ts: "123.456" })
      .mockResolvedValueOnce({ ts: "123.789" });
    const update = vi.fn().mockResolvedValue({});
    const deleteMessage = vi.fn().mockResolvedValue({});
    const startStream = vi.fn().mockRejectedValue(new Error("stream_not_allowed"));
    const appendStream = vi.fn();
    const stopStream = vi.fn();
    const webClient = {
      chat: { postMessage, update, delete: deleteMessage, startStream, appendStream, stopStream },
    } as never;

    const controller = createSlackReplyStreamController(webClient, {
      channel: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      linearWorkspace: "kyaukyuai",
    });

    await controller.enableStreaming();
    controller.pushTextDelta("こんにちは");

    const text = await controller.finalizeReply("こんにちは");

    expect(text).toBe("こんにちは");
    expect(deleteMessage).toHaveBeenCalledWith({
      channel: "C123",
      ts: "123.456",
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      thread_ts: "111.222",
      text: "考え中...",
    });
    expect(update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "123.789",
      text: "こんにちは",
      blocks: expect.any(Array),
    });
    expect(stopStream).not.toHaveBeenCalled();
  });

  it("posts a mention message into the current thread", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "123.999" });
    const update = vi.fn();
    const webClient = {
      chat: { postMessage, update },
    } as never;

    const result = await postSlackMentionMessage(webClient, {
      channel: "C123",
      threadTs: "111.222",
      mentionSlackUserId: "U999",
      messageText: "こんにちは",
      linearWorkspace: "kyaukyuai",
    });

    expect(result).toEqual({
      text: "@U999 こんにちは",
      ts: "123.999",
    });
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "111.222",
      text: "@U999 こんにちは",
      blocks: expect.any(Array),
    });
  });

  it("posts a root mention message without thread_ts when targeting control-room-root", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "124.000" });
    const update = vi.fn();
    const webClient = {
      chat: { postMessage, update },
    } as never;

    await postSlackMentionMessage(webClient, {
      channel: "C999",
      mentionSlackUserId: "U999",
      messageText: "確認お願いします",
      linearWorkspace: "kyaukyuai",
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C999",
      thread_ts: undefined,
      text: "@U999 確認お願いします",
      blocks: expect.any(Array),
    });
  });
});
