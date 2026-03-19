import type { LinearIssue } from "../../lib/linear.js";

type SlackIssueLabel = Pick<LinearIssue, "identifier" | "title"> & { url?: string | null };

export function truncateSlackText(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildSlackTargetLabel(
  issue: SlackIssueLabel,
  maxLength = 80,
): string {
  const label = `${issue.identifier} ${truncateSlackText(issue.title, maxLength)}`;
  return issue.url ? `<${issue.url}|${label}>` : label;
}

function joinNaturalLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} と ${labels[1]}`;
  return `${labels.slice(0, -1).join("、")}、${labels[labels.length - 1]}`;
}

export function formatSlackIssueListSentence(args: {
  subject: string;
  issues: SlackIssueLabel[];
  limit?: number;
  titleMaxLength?: number;
}): string | undefined {
  if (args.issues.length === 0) return undefined;
  const limit = args.limit ?? 2;
  const titleMaxLength = args.titleMaxLength ?? 80;
  const visible = args.issues
    .slice(0, limit)
    .map((issue) => buildSlackTargetLabel(issue, titleMaxLength));
  const overflow = args.issues.length > limit ? ` ほか${args.issues.length - limit}件あります。` : "";
  return `${args.subject}${joinNaturalLabels(visible)} です。${overflow}`;
}

export function formatSlackBullets(lines: Array<string | undefined>): string | undefined {
  const visible = lines
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line));
  if (visible.length === 0) return undefined;
  return visible.map((line) => (line.startsWith("- ") ? line : `- ${line}`)).join("\n");
}

export function joinSlackSentences(sentences: Array<string | undefined>): string | undefined {
  const visible = sentences
    .map((sentence) => sentence?.trim())
    .filter((sentence): sentence is string => Boolean(sentence));
  if (visible.length === 0) return undefined;
  return visible.join(" ");
}

export function composeSlackReply(paragraphs: Array<string | undefined>): string {
  return paragraphs
    .map((paragraph) => paragraph?.trim())
    .filter((paragraph): paragraph is string => Boolean(paragraph))
    .join("\n\n");
}

export function formatSlackThreadReference(reference: string, label = "こちら"): string {
  if (/^https?:\/\//.test(reference)) {
    return `<${reference}|${label}>`;
  }
  return reference;
}
