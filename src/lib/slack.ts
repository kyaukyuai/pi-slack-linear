export interface RawSlackMessageEvent {
  text?: string;
  channel: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  channel_type?: string;
  files?: Array<{
    id?: string;
    name: string;
    mimetype?: string;
    filetype?: string;
    url_private_download?: string;
    url_private?: string;
  }>;
}

export interface NormalizedSlackMessage {
  channelId: string;
  userId: string;
  ts: string;
  rootThreadTs: string;
  text: string;
  files: RawSlackMessageEvent["files"];
}

export type TaskIntent = "task_request" | "conversation";

export function isProcessableSlackMessage(
  event: RawSlackMessageEvent,
  botUserId: string,
  allowedChannelIds: Set<string>,
): boolean {
  if (!allowedChannelIds.has(event.channel)) return false;
  if (event.channel_type === "im") return false;
  if (event.bot_id) return false;
  if (!event.user || event.user === botUserId) return false;
  if (event.subtype !== undefined && event.subtype !== "file_share") return false;
  if (!(event.text ?? "").trim() && (!event.files || event.files.length === 0)) return false;
  return true;
}

export function normalizeSlackMessage(event: RawSlackMessageEvent): NormalizedSlackMessage {
  return {
    channelId: event.channel,
    userId: event.user ?? "",
    ts: event.ts,
    rootThreadTs: event.thread_ts ?? event.ts,
    text: (event.text ?? "").trim(),
    files: event.files ?? [],
  };
}

export function classifyTaskIntent(text: string): TaskIntent {
  const normalized = text.trim();
  if (!normalized) return "conversation";

  const taskPattern =
    /(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|確認して|一覧|完了にして|終わった|閉じて|更新して|track|create|add|open|list|check|complete|close|update)/i;

  return taskPattern.test(normalized) ? "task_request" : "conversation";
}
