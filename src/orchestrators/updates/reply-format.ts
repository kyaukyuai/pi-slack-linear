import type { LinearIssue } from "../../lib/linear.js";
import type { FollowupLedgerEntry } from "../../state/manager-state-contract.js";
import type { FollowupResolutionResult } from "../../lib/pi-session.js";
import {
  buildSlackTargetLabel,
  composeSlackReply,
  formatSlackIssueListSentence,
  joinSlackSentences,
  truncateSlackText,
} from "../shared/slack-conversation.js";

type UpdateSignal = "progress" | "completed" | "blocked";

function isCanceledIssueState(issue: LinearIssue): boolean {
  const stateName = issue.state?.name?.trim().toLowerCase();
  return stateName === "canceled" || stateName === "cancelled";
}

export function formatStatusReply(
  kind: UpdateSignal,
  issues: LinearIssue[],
  extras: string[] = [],
): string {
  const allCanceled = kind === "completed" && issues.length > 0 && issues.every(isCanceledIssueState);
  const intro = allCanceled
    ? "Canceled に変更しました。"
    : kind === "completed"
      ? "完了として反映しました。"
    : kind === "blocked"
      ? "blocked を反映しました。"
      : "進捗を反映しました。";
  const nextAction = allCanceled
    ? "必要ならこの thread で訂正や続きの依頼を送ってください。"
    : kind === "completed"
      ? "残っている作業があれば、この thread で続けてください。"
    : kind === "blocked"
      ? "原因・待ち先・再開条件が分かったら、この thread で追記してください。"
      : "必要ならこの thread で続きの進捗を共有してください。";

  return composeSlackReply([
    joinSlackSentences([
      intro,
      formatSlackIssueListSentence({
        subject: "対象は ",
        issues,
        limit: issues.length,
      }),
      nextAction,
    ]),
    extras.length > 0 ? extras.map((line) => `- ${line}`).join("\n") : undefined,
  ]);
}

export function formatFollowupResolutionReply(
  followup: FollowupLedgerEntry,
  issue: LinearIssue,
  assessment: FollowupResolutionResult,
): string {
  const answered = assessment.answered && assessment.confidence >= 0.7;
  const paragraphs = [
    joinSlackSentences([
      answered ? "返答を反映しました。" : "返答を受け取りました。",
      `対象は ${buildSlackTargetLabel(issue)} です。`,
    ]),
  ];

  if (!answered) {
    if (assessment.reasoningSummary) {
      paragraphs.push(`見立てとしては、${truncateSlackText(assessment.reasoningSummary, 90)}`);
    }
    paragraphs.push(`${followup.requestText ?? "追加情報をお願いします。"} 引き続きこの内容を教えてください。`);
    if (followup.acceptableAnswerHint) {
      paragraphs.push(`返し方は ${followup.acceptableAnswerHint} の形だと取り込みやすいです。`);
    }
  } else if (followup.requestKind === "owner" && assessment.extractedFields?.assignee) {
    paragraphs.push(`担当は ${assessment.extractedFields.assignee} として反映しました。`);
  } else if (followup.requestKind === "due-date" && assessment.extractedFields?.dueDate) {
    paragraphs.push(`期限は ${assessment.extractedFields.dueDate} として反映しました。`);
  } else {
    if (assessment.reasoningSummary) {
      paragraphs.push(`見立てとしては、${truncateSlackText(assessment.reasoningSummary, 90)}`);
    }
    paragraphs.push("追加情報があれば、この thread で続けてください。");
  }

  return composeSlackReply(paragraphs);
}
