function extractTextFromAssistantContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
        return String(item.text);
      }
      return "";
    })
    .join("")
    .trim();
}

export function extractLatestAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;

    const text = extractTextFromAssistantContent(message.content);
    if (text) {
      return text;
    }
  }

  return "";
}

export function selectFinalAssistantText(messages: unknown[], deltas: string[]): string {
  const latestAssistantText = extractLatestAssistantText(messages);
  if (latestAssistantText) {
    return latestAssistantText;
  }
  return deltas.join("").trim();
}
