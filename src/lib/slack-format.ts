const SLACK_SECTION_TEXT_LIMIT = 3000;

type SlackMrkdwnBlock = {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
};

type SlackRichTextStyle = {
  bold?: boolean;
  code?: boolean;
};

type SlackRichTextTextElement = {
  type: "text";
  text: string;
  style?: SlackRichTextStyle;
};

type SlackRichTextLinkElement = {
  type: "link";
  url: string;
  text?: string;
  style?: SlackRichTextStyle;
};

type SlackRichTextElement = SlackRichTextTextElement | SlackRichTextLinkElement;

type SlackRichTextSection = {
  type: "rich_text_section";
  elements: SlackRichTextElement[];
};

type SlackRichTextList = {
  type: "rich_text_list";
  style: "bullet";
  elements: SlackRichTextSection[];
};

type SlackRichTextBlock = {
  type: "rich_text";
  elements: SlackRichTextList[];
};

export interface SlackMessagePayload {
  text: string;
  blocks: Array<SlackMrkdwnBlock | SlackRichTextBlock>;
}

function withIssueLinks(text: string, linearWorkspace?: string): string {
  if (!linearWorkspace) return text;

  return text
    .split(/(<[^>]+>)/g)
    .map((segment) => {
      if (segment.startsWith("<") && segment.endsWith(">")) {
        return segment;
      }
      return segment.replace(/\b([A-Z][A-Z0-9]+-\d+)\b/g, (_match, issueId: string) => {
        return `<https://linear.app/${linearWorkspace}/issue/${issueId}|${issueId}>`;
      });
    })
    .join("");
}

function normalizeInlineBullets(text: string): string {
  return text
    .replace(/([。!！?？])\s*-\s+/g, "$1\n- ")
    .replace(/([。!！?？])\s*•\s+/g, "$1\n- ")
    .replace(/\n?•\s+/g, "\n- ");
}

function splitLongLine(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "), slice.lastIndexOf("、"));
    const cut = breakAt >= Math.floor(maxLength * 0.6) ? breakAt : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function splitSlackMrkdwnSections(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const sections: string[] = [];
  let current = "";

  const pushPart = (part: string) => {
    if (!part) return;
    if (!current) {
      current = part;
      return;
    }
    const candidate = `${current}\n\n${part}`;
    if (candidate.length <= SLACK_SECTION_TEXT_LIMIT) {
      current = candidate;
      return;
    }
    sections.push(current);
    current = part;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length <= SLACK_SECTION_TEXT_LIMIT) {
      pushPart(paragraph);
      continue;
    }
    const lines = paragraph.split("\n").flatMap((line) => splitLongLine(line, SLACK_SECTION_TEXT_LIMIT));
    for (const line of lines) {
      pushPart(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

function formatSlackPlainText(mrkdwn: string): string {
  return mrkdwn
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/^[>]\s?/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mergeRichTextStyle(
  base: SlackRichTextStyle | undefined,
  extra: SlackRichTextStyle | undefined,
): SlackRichTextStyle | undefined {
  const merged = {
    ...(base ?? {}),
    ...(extra ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function parseRichTextElements(
  text: string,
  inheritedStyle?: SlackRichTextStyle,
): SlackRichTextElement[] {
  const elements: SlackRichTextElement[] = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] === "`") {
      const closingIndex = text.indexOf("`", index + 1);
      if (closingIndex > index + 1) {
        elements.push({
          type: "text",
          text: text.slice(index + 1, closingIndex),
          style: mergeRichTextStyle(inheritedStyle, { code: true }),
        });
        index = closingIndex + 1;
        continue;
      }
    }

    if (text[index] === "*") {
      const closingIndex = text.indexOf("*", index + 1);
      if (closingIndex > index + 1) {
        elements.push(
          ...parseRichTextElements(
            text.slice(index + 1, closingIndex),
            mergeRichTextStyle(inheritedStyle, { bold: true }),
          ),
        );
        index = closingIndex + 1;
        continue;
      }
    }

    if (text[index] === "<") {
      const closingIndex = text.indexOf(">", index + 1);
      const pipeIndex = text.indexOf("|", index + 1);
      if (closingIndex > index && pipeIndex > index && pipeIndex < closingIndex) {
        const url = text.slice(index + 1, pipeIndex);
        const label = text.slice(pipeIndex + 1, closingIndex);
        elements.push({
          type: "link",
          url,
          text: label,
          style: inheritedStyle,
        });
        index = closingIndex + 1;
        continue;
      }
    }

    const nextCode = text.indexOf("`", index);
    const nextBold = text.indexOf("*", index);
    const nextLink = text.indexOf("<", index);
    const candidateIndexes = [nextCode, nextBold, nextLink].filter((value) => value >= 0);
    const nextSpecialIndex = candidateIndexes.length > 0
      ? Math.min(...candidateIndexes)
      : text.length;

    if (nextSpecialIndex > index) {
      elements.push({
        type: "text",
        text: text.slice(index, nextSpecialIndex),
        style: inheritedStyle,
      });
      index = nextSpecialIndex;
      continue;
    }

    elements.push({
      type: "text",
      text: text[index],
      style: inheritedStyle,
    });
    index += 1;
  }

  return elements.filter((element) => {
    if (element.type === "text") {
      return element.text.length > 0;
    }
    return Boolean(element.url);
  });
}

function buildRichTextListBlock(lines: string[]): SlackRichTextBlock {
  return {
    type: "rich_text",
    elements: [{
      type: "rich_text_list",
      style: "bullet",
      elements: lines.map((line) => ({
        type: "rich_text_section",
        elements: parseRichTextElements(line.replace(/^- /, "").trim()),
      })),
    }],
  };
}

function buildSlackBlocks(mrkdwn: string): Array<SlackMrkdwnBlock | SlackRichTextBlock> {
  const blocks: Array<SlackMrkdwnBlock | SlackRichTextBlock> = [];

  for (const section of splitSlackMrkdwnSections(mrkdwn)) {
    const paragraphs = section
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    for (const paragraph of paragraphs) {
      const lines = paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) continue;
      let paragraphBuffer: string[] = [];
      let bulletBuffer: string[] = [];

      const flushParagraph = () => {
        if (paragraphBuffer.length === 0) return;
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: paragraphBuffer.join("\n"),
          },
        });
        paragraphBuffer = [];
      };

      const flushBullets = () => {
        if (bulletBuffer.length === 0) return;
        blocks.push(buildRichTextListBlock(bulletBuffer));
        bulletBuffer = [];
      };

      for (const line of lines) {
        if (line.startsWith("- ")) {
          flushParagraph();
          bulletBuffer.push(line);
        } else {
          flushBullets();
          paragraphBuffer.push(line);
        }
      }

      flushParagraph();
      flushBullets();
    }
  }

  return blocks;
}

export function formatSlackMessageText(markdown: string, linearWorkspace?: string): string {
  let text = markdown;
  const boldPlaceholders: string[] = [];

  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  text = text.replace(/```[a-zA-Z0-9_-]+\n/g, "```\n");
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content: string) => {
    const index = boldPlaceholders.push(content.trim()) - 1;
    return `@@BOLD_${index}@@`;
  });
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
  text = text.replace(/\*\*([^*]+?)\*\*/g, (_match, content: string) => {
    const index = boldPlaceholders.push(content) - 1;
    return `@@BOLD_${index}@@`;
  });
  text = text.replace(/__([^_]+?)__/g, (_match, content: string) => {
    const index = boldPlaceholders.push(content) - 1;
    return `@@BOLD_${index}@@`;
  });
  text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "*$1*");
  text = text.replace(/~~([^~]+?)~~/g, "~$1~");
  text = text.replace(/@@BOLD_(\d+)@@/g, (_match, index: string) => `*${boldPlaceholders[Number(index)]}*`);
  text = normalizeInlineBullets(text);
  text = withIssueLinks(text, linearWorkspace);
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function buildSlackMessagePayload(markdown: string, options?: { linearWorkspace?: string }): SlackMessagePayload {
  const mrkdwn = formatSlackMessageText(markdown, options?.linearWorkspace);
  return {
    text: formatSlackPlainText(mrkdwn),
    blocks: buildSlackBlocks(mrkdwn),
  };
}
