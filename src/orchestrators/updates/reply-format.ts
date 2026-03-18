import type { LinearIssue } from "../../lib/linear.js";
import type { FollowupLedgerEntry } from "../../lib/manager-state.js";
import type { FollowupResolutionResult } from "../../lib/pi-session.js";

type UpdateSignal = "progress" | "completed" | "blocked";

function truncateSlackText(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildSlackTargetLabel(
  issue: Pick<LinearIssue, "identifier" | "title"> & { url?: string | null },
  maxLength = 80,
): string {
  const label = `${issue.identifier} ${truncateSlackText(issue.title, maxLength)}`;
  return issue.url ? `<${issue.url}|${label}>` : label;
}

function formatThreadReplyForSlack(args: {
  headline: string;
  target?: string;
  lines?: string[];
  url?: string;
  maxLines?: number;
}): string {
  const maxLines = args.maxLines ?? 4;
  const bodyLines = (args.lines ?? []).filter((line) => line.trim().length > 0);
  const lines = [args.headline];
  if (args.target) {
    lines.push(`対象: ${args.target}`);
  }

  const urlLine = args.url ? `詳細: <${args.url}|Linear issue>` : undefined;
  const reservedForUrl = urlLine ? 1 : 0;
  const remaining = Math.max(0, maxLines - lines.length - reservedForUrl);
  lines.push(...bodyLines.slice(0, remaining));
  if (urlLine && lines.length < maxLines) {
    lines.push(urlLine);
  }

  if (lines.length <= 1) return lines.join("\n");
  return [lines[0], "", ...lines.slice(1)].join("\n");
}

export function formatStatusReply(
  kind: UpdateSignal,
  issues: LinearIssue[],
  extras: string[] = [],
): string {
  const target = issues.map((issue) => buildSlackTargetLabel(issue)).join(" / ");
  const headline = kind === "completed"
    ? "完了を Linear に反映しました。"
    : kind === "blocked"
      ? "blocked 状態を Linear に反映しました。"
      : "進捗を Linear に反映しました。";
  const nextAction = kind === "completed"
    ? "次アクション: 残っている作業があれば、この thread で続けてください。"
    : kind === "blocked"
      ? "次アクション: 原因 / 待ち先 / 再開条件 が分かったら、この thread で追記してください。"
      : "次アクション: 必要ならこの thread で続きの進捗を共有してください。";

  return formatThreadReplyForSlack({
    headline,
    target,
    lines: [nextAction, ...extras],
    maxLines: extras.length > 0 ? 5 : 4,
  });
}

export function formatFollowupResolutionReply(
  followup: FollowupLedgerEntry,
  issue: LinearIssue,
  assessment: FollowupResolutionResult,
): string {
  const answered = assessment.answered && assessment.confidence >= 0.7;
  const lines: string[] = [];
  if (assessment.reasoningSummary) {
    lines.push(`判定: ${truncateSlackText(assessment.reasoningSummary, 90)}`);
  }

  if (!answered) {
    lines.push(`引き続き必要な返答: ${followup.requestText ?? "追加情報をお願いします。"}`);
    if (followup.acceptableAnswerHint) {
      lines.push(`返答フォーマット: ${followup.acceptableAnswerHint}`);
    }
  } else if (followup.requestKind === "owner" && assessment.extractedFields?.assignee) {
    lines.push(`担当: ${assessment.extractedFields.assignee}`);
  } else if (followup.requestKind === "due-date" && assessment.extractedFields?.dueDate) {
    lines.push(`期限: ${assessment.extractedFields.dueDate}`);
  } else {
    lines.push("次アクション: 追加情報があればこの thread で続けてください。");
  }

  return formatThreadReplyForSlack({
    headline: answered ? "follow-up への返答を Linear に反映しました。" : "follow-up への返答を受け取りました。",
    target: buildSlackTargetLabel(issue),
    lines,
    maxLines: 5,
  });
}
