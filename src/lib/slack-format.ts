export function formatSlackMessageText(markdown: string): string {
  let text = markdown;
  const boldPlaceholders: string[] = [];

  // Remove compatibility zero-width characters that can show up around emphasis.
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // Slack ignores fenced code block language identifiers.
  text = text.replace(/```[a-zA-Z0-9_-]+\n/g, "```\n");

  // Headings do not render in Slack mrkdwn.
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content: string) => {
    const index = boldPlaceholders.push(content.trim()) - 1;
    return `@@BOLD_${index}@@`;
  });

  // Markdown links.
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");

  // Protect strong emphasis before italic conversion.
  text = text.replace(/\*\*([^*]+?)\*\*/g, (_match, content: string) => {
    const index = boldPlaceholders.push(content) - 1;
    return `@@BOLD_${index}@@`;
  });
  text = text.replace(/__([^_]+?)__/g, (_match, content: string) => {
    const index = boldPlaceholders.push(content) - 1;
    return `@@BOLD_${index}@@`;
  });

  // Italics.
  text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "_$1_");

  // Strikethrough.
  text = text.replace(/~~([^~]+?)~~/g, "~$1~");

  text = text.replace(/@@BOLD_(\d+)@@/g, (_match, index: string) => `*${boldPlaceholders[Number(index)]}*`);

  // Normalize list bullets for readability in plain text Slack posts.
  text = text.replace(/^•\s+/gm, "- ");

  return text;
}
