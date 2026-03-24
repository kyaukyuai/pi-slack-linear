import type { WebClient } from "@slack/web-api";
import { buildSlackMessagePayload } from "./slack-format.js";

const DEFAULT_PROCESSING_NOTICE = "考え中...";

type SlackChatClient = Pick<WebClient, "chat">;

export async function postSlackProcessingNotice(
  webClient: SlackChatClient,
  args: {
    channel: string;
    threadTs?: string;
    text?: string;
  },
): Promise<string | undefined> {
  const result = await webClient.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: args.text ?? DEFAULT_PROCESSING_NOTICE,
  });
  return result.ts;
}

export async function sendSlackReply(
  webClient: SlackChatClient,
  args: {
    channel: string;
    reply: string;
    threadTs?: string;
    linearWorkspace: string;
    updateTs?: string;
  },
): Promise<string> {
  const payload = buildSlackMessagePayload(args.reply, { linearWorkspace: args.linearWorkspace });
  if (args.updateTs) {
    try {
      await webClient.chat.update({
        channel: args.channel,
        ts: args.updateTs,
        text: payload.text,
        blocks: payload.blocks,
      });
      return payload.text;
    } catch {
      // Fall back to a fresh thread reply when the placeholder cannot be updated.
    }
  }

  await webClient.chat.postMessage({
    channel: args.channel,
    thread_ts: args.threadTs,
    text: payload.text,
    blocks: payload.blocks,
  });
  return payload.text;
}
