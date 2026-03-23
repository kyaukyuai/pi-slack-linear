import type { MessageRouterInput } from "./contract.js";

function formatRecentEntries(input: MessageRouterInput): string {
  if (input.recentThreadEntries.length === 0) {
    return "- (none)";
  }

  return input.recentThreadEntries
    .slice(-6)
    .map((entry) => `- [${entry.role}] ${entry.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

export function buildMessageRouterPrompt(input: MessageRouterInput): string {
  const threadContext = input.threadContext;
  const lastQueryContext = input.lastQueryContext;

  return [
    "Classify the latest Slack message for a Slack-first execution manager.",
    "Reply with a single JSON object only.",
    'Use exactly one of these schemas:',
    '{"action":"conversation","conversationKind":"greeting"|"smalltalk"|"other","confidence":number,"reasoningSummary":string}',
    '{"action":"query","queryKind":"list-active"|"list-today"|"what-should-i-do"|"inspect-work"|"search-existing"|"recommend-next-step"|"reference-material","queryScope":"self"|"team"|"thread-context","confidence":number,"reasoningSummary":string}',
    '{"action":"create_work","confidence":number,"reasoningSummary":string}',
    '{"action":"update_progress","confidence":number,"reasoningSummary":string}',
    '{"action":"update_completed","confidence":number,"reasoningSummary":string}',
    '{"action":"update_blocked","confidence":number,"reasoningSummary":string}',
    "Keep reasoningSummary concise and in Japanese.",
    "Choose conversation for greetings, light smalltalk, or non-task chatter.",
    "Choose query for read-only questions about tasks, status, lists, search, or next-step guidance.",
    "Choose create_work for new task creation requests and replies that answer a pending clarification for task creation.",
    "Choose update_progress / update_completed / update_blocked only for status-changing updates about existing work.",
    "Use queryScope=self when the user asks about their own work.",
    "Use queryScope=thread-context when the message depends on the current thread, says things like この件 / 他には / その件, or clearly continues a prior query in the same thread.",
    "Use queryScope=team for general task list or team-wide queries.",
    "If threadContext.pendingClarification is true and the latest message appears to answer that clarification, choose create_work.",
    'Example: "こんばんは" -> {"action":"conversation","conversationKind":"greeting",...}',
    'Example: "今日やるべきタスクはある？" -> {"action":"query","queryKind":"what-should-i-do","queryScope":"team",...}',
    'Example: "自分の今日やるべきタスクはある？" -> {"action":"query","queryKind":"what-should-i-do","queryScope":"self",...}',
    'Example: "他にはどのようなタスクがある？" after a task-list reply in the same thread -> {"action":"query","queryKind":"list-active","queryScope":"thread-context",...}',
    'Example: "AIC-38 次どう進める？" -> {"action":"query","queryKind":"recommend-next-step","queryScope":"thread-context",...}',
    'Example: "Notion を確認して" -> {"action":"query","queryKind":"reference-material","queryScope":"team",...}',
    'Example: "進捗です。招待依頼を出しました" -> {"action":"update_progress",...}',
    `Current date in Asia/Tokyo: ${input.currentDate}`,
    "",
    "Thread context:",
    `- pendingClarification: ${threadContext?.pendingClarification ? "yes" : "no"}`,
    `- intakeStatus: ${threadContext?.intakeStatus ?? "(none)"}`,
    `- clarificationQuestion: ${threadContext?.clarificationQuestion ?? "(none)"}`,
    `- originalRequestText: ${threadContext?.originalRequestText ?? "(none)"}`,
    `- parentIssueId: ${threadContext?.parentIssueId ?? "(none)"}`,
    `- childIssueIds: ${threadContext?.childIssueIds.join(", ") || "(none)"}`,
    `- linkedIssueIds: ${threadContext?.linkedIssueIds.join(", ") || "(none)"}`,
    `- latestFocusIssueId: ${threadContext?.latestFocusIssueId ?? "(none)"}`,
    `- lastResolvedIssueId: ${threadContext?.lastResolvedIssueId ?? "(none)"}`,
    "",
    "Last query continuation context:",
    `- kind: ${lastQueryContext?.kind ?? "(none)"}`,
    `- scope: ${lastQueryContext?.scope ?? "(none)"}`,
    `- issueIds: ${lastQueryContext?.issueIds.join(", ") || "(none)"}`,
    `- shownIssueIds: ${lastQueryContext?.shownIssueIds.join(", ") || "(none)"}`,
    `- remainingIssueIds: ${lastQueryContext?.remainingIssueIds.join(", ") || "(none)"}`,
    `- totalItemCount: ${lastQueryContext?.totalItemCount ?? 0}`,
    `- previousUserMessage: ${lastQueryContext?.userMessage ?? "(none)"}`,
    `- previousReplySummary: ${lastQueryContext?.replySummary ?? "(none)"}`,
    `- recordedAt: ${lastQueryContext?.recordedAt ?? "(none)"}`,
    "",
    "Recent thread messages:",
    formatRecentEntries(input),
    "",
    "Latest message:",
    input.messageText,
  ].join("\n");
}
