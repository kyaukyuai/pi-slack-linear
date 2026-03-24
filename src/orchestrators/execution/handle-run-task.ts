const ISSUE_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;
const THREAD_BOUND_TARGET_PATTERN = /(?:この|その)\s*(?:issue|イシュー|タスク|課題)/i;
const EXECUTION_REQUEST_PATTERN = /(?:進めて(?:ください)?|実行して(?:ください)?|やって(?:ください)?|対応して(?:ください)?|動かして(?:ください)?|片付けて(?:ください)?)/i;
const EXECUTION_QUERY_PATTERN = /(?:どう進め|どうすれば|次どう|何をすべき|何をしたら|どう動く)/i;

export function isRunTaskRequestText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (EXECUTION_QUERY_PATTERN.test(normalized)) return false;
  if (!EXECUTION_REQUEST_PATTERN.test(normalized)) return false;
  return ISSUE_IDENTIFIER_PATTERN.test(normalized) || THREAD_BOUND_TARGET_PATTERN.test(normalized);
}

export function extractExplicitRunTaskIssueIdentifier(text: string): string | undefined {
  return text.match(ISSUE_IDENTIFIER_PATTERN)?.[0];
}

export function buildRunTaskClarifyReply(): string {
  return "いまは実行対象を安全に確定できないため、`AIC-123` のように issue ID を添えてもう一度送ってください。";
}

export function buildRunTaskActionClarifyReply(issueIdentifier?: string): string {
  return issueIdentifier
    ? `${issueIdentifier} に対して何を実行したいかを安全に確定できないため、状態変更・コメント追加・Notion更新など、やりたい操作をもう一度短く教えてください。`
    : "実行内容を安全に確定できないため、状態変更・コメント追加・Notion更新など、やりたい操作をもう一度短く教えてください。";
}

export function buildRunTaskNoopReply(issueIdentifier?: string): string {
  return issueIdentifier
    ? `${issueIdentifier} を確認しましたが、現時点で追加の自動実行価値はありませんでした。`
    : "対象の issue を確認しましたが、現時点で追加の自動実行価値はありませんでした。";
}
