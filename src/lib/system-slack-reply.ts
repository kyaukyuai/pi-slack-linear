import { composeSlackReply, formatSlackBullets } from "../orchestrators/shared/slack-conversation.js";

function normalizeForCompare(text: string): string {
  return text
    .replace(/<[^|>]+\|([^>]+)>/g, "$1")
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractSlackUrls(text: string): string[] {
  return Array.from(text.matchAll(/<([^|>\s]+)(?:\|[^>]+)?>/g))
    .map((match) => match[1] ?? "")
    .filter((value) => /^https?:\/\//.test(value));
}

function extractIssueIds(text: string): string[] {
  return Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

function looksLikeFollowupSummary(summary: string): boolean {
  return /follow-up を作成しました/.test(summary);
}

function agentAlreadyCoversFollowup(agentReply: string, summary: string): boolean {
  const issueIds = extractIssueIds(summary);
  if (issueIds.length === 0 || !issueIds.every((issueId) => agentReply.includes(issueId))) {
    return false;
  }
  return /(確認|follow-up|フォローアップ|送[り付信]|連絡)/.test(agentReply);
}

function shouldSuppressCommitSummary(agentReply: string, summary: string): boolean {
  const summaryUrls = extractSlackUrls(summary);
  if (summaryUrls.length > 0) {
    const agentUrls = extractSlackUrls(agentReply);
    const agentCoversUrls = summaryUrls.every((url) => agentUrls.includes(url));
    if (!agentCoversUrls) {
      return false;
    }
  }
  const normalizedAgentReply = normalizeForCompare(agentReply);
  const normalizedSummary = normalizeForCompare(summary);
  if (!normalizedAgentReply || !normalizedSummary) {
    return false;
  }
  if (normalizedAgentReply.includes(normalizedSummary)) {
    return true;
  }
  return looksLikeFollowupSummary(summary) && agentAlreadyCoversFollowup(agentReply, summary);
}

function isPipeTableSeparator(line: string): boolean {
  return /^\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(line.trim());
}

function isPipeTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|");
}

function parsePipeTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function formatPipeTableRow(headers: string[], row: string[]): string | undefined {
  if (row.every((cell) => !cell)) {
    return undefined;
  }

  const primary = [row[0], row[1]].filter(Boolean).join(" ").trim();
  const details = headers
    .map((header, index) => ({ header, value: row[index] }))
    .slice(2)
    .filter((entry) => entry.header && entry.value)
    .map((entry) => `${entry.header}: ${entry.value}`);

  if (!primary && details.length === 0) {
    return undefined;
  }

  if (!primary) {
    return `- ${details.join(" / ")}`;
  }
  return `- ${primary}${details.length > 0 ? ` / ${details.join(" / ")}` : ""}`;
}

function convertPipeTablesToBullets(text: string): string {
  const lines = text.split("\n");
  const next: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const separator = lines[index + 1] ?? "";
    if (!isPipeTableLine(line) || !isPipeTableSeparator(separator)) {
      next.push(line);
      continue;
    }

    const headers = parsePipeTableCells(line);
    const bullets: string[] = [];
    index += 2;
    while (index < lines.length && isPipeTableLine(lines[index] ?? "")) {
      const bullet = formatPipeTableRow(headers, parsePipeTableCells(lines[index] ?? ""));
      if (bullet) {
        bullets.push(bullet);
      }
      index += 1;
    }
    index -= 1;

    if (bullets.length > 0) {
      next.push(...bullets);
    }
  }

  return next.join("\n");
}

export function normalizeSystemReplyForSlack(text: string): string {
  return convertPipeTablesToBullets(text)
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatSystemLogs(commitSummaries: string[]): string {
  return commitSummaries
    .map((summary) => `> system log: ${summary}`)
    .join("\n");
}

function buildSystemCommitRejectionReply(commitRejections: string[]): string | undefined {
  if (commitRejections.length === 0) return undefined;
  if (commitRejections.length === 1) {
    return `一部は ${commitRejections[0]} ため、そのまま確定していません。`;
  }
  return composeSlackReply([
    "一部はそのまま確定できていません。",
    formatSlackBullets(commitRejections),
  ]);
}

export function mergeSystemReply(args: {
  agentReply: string;
  commitSummaries: string[];
  commitRejections: string[];
}): string {
  const normalizedAgentReply = normalizeSystemReplyForSlack(args.agentReply);
  const visibleCommitSummaries = normalizedAgentReply
    ? args.commitSummaries.filter((summary) => !shouldSuppressCommitSummary(normalizedAgentReply, summary))
    : args.commitSummaries;

  const paragraphs: string[] = [];
  if (normalizedAgentReply) {
    paragraphs.push(normalizedAgentReply);
  }
  if (visibleCommitSummaries.length > 0) {
    if (normalizedAgentReply) {
      paragraphs.push(formatSystemLogs(visibleCommitSummaries));
    } else {
      paragraphs.push(...visibleCommitSummaries);
    }
  }

  const rejectionReply = buildSystemCommitRejectionReply(args.commitRejections);
  if (rejectionReply) {
    paragraphs.push(rejectionReply);
  }

  return composeSlackReply(paragraphs);
}
