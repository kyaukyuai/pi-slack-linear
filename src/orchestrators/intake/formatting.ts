import type { LinearIssue } from "../../lib/linear.js";
import type { ResearchSynthesisResult } from "../../lib/pi-session.js";
import {
  getRecentChannelContext,
  getSlackThreadContext,
} from "../../lib/slack-context.js";
import {
  webFetchUrl,
  webSearchFetch,
} from "../../lib/web-research.js";

interface SourceMessageLike {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  text: string;
}

type SlackThreadEntries = Awaited<ReturnType<typeof getSlackThreadContext>>["entries"];
type RecentChannelContexts = Awaited<ReturnType<typeof getRecentChannelContext>>;
type SearchResults = Awaited<ReturnType<typeof webSearchFetch>>;
type FetchedPages = Awaited<ReturnType<typeof webFetchUrl>>[];

function extractTopLines(lines: string[], fallback: string): string {
  if (lines.length === 0) return `- ${fallback}`;
  return lines.map((line) => `- ${line}`).join("\n");
}

function formatResearchNextActions(nextActions: ResearchSynthesisResult["nextActions"]): string {
  return extractTopLines(
    nextActions.map((action) => action.title),
    "調査結果をもとに必要な実行子 issue を追加する。",
  );
}

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

function formatChildIssueSummaryForSlack(
  children: LinearIssue[],
  options?: { limit?: number; titleMaxLength?: number },
): string | undefined {
  if (children.length === 0) return undefined;
  const limit = options?.limit ?? 2;
  const titleMaxLength = options?.titleMaxLength ?? 80;
  const visible = children
    .slice(0, limit)
    .map((issue) => buildSlackTargetLabel(issue, titleMaxLength));
  const suffix = children.length > limit ? ` (+${children.length - limit}件)` : "";
  return `子task: ${visible.join(" / ")}${suffix}`;
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

export function compactLinearIssues(issues: Array<LinearIssue | undefined>): LinearIssue[] {
  return issues.filter((issue): issue is LinearIssue => Boolean(issue));
}

export function formatSourceComment(message: SourceMessageLike, reason: string): string {
  return [
    "## Slack source",
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    `- reason: ${reason}`,
    "",
    "## Original message",
    message.text,
  ].join("\n");
}

export function formatSlackContextSummary(entries: SlackThreadEntries): string {
  if (entries.length === 0) {
    return "- thread 内の追加文脈は見つかりませんでした。";
  }

  return entries
    .slice(-8)
    .map((entry) => `- [${entry.type}] ${entry.text.replace(/\s+/g, " ").slice(0, 180)}`)
    .join("\n");
}

export function formatRelatedIssuesSummary(issues: LinearIssue[]): string {
  if (issues.length === 0) {
    return "- 関連 issue は見つかりませんでした。";
  }

  return issues.slice(0, 5).map((issue) => {
    const state = issue.state?.name ?? "state unknown";
    return `- ${issue.identifier} / ${issue.title} / ${state}`;
  }).join("\n");
}

export function formatWebSummary(
  searchResults: SearchResults,
  fetchedPages: FetchedPages,
): string {
  if (searchResults.length === 0) {
    return "- Web 検索では有意な結果を取得できませんでした。";
  }

  return searchResults.slice(0, 3).map((result, index) => {
    const page = fetchedPages[index];
    const snippet = page?.snippet ?? result.snippet ?? "";
    return `- ${result.title}\n  - URL: ${result.url}\n  - 要約: ${snippet.slice(0, 180)}`;
  }).join("\n");
}

export function formatIssueReference(
  issue: Pick<LinearIssue, "identifier" | "title"> & { url?: string | null },
): string {
  return issue.url
    ? `<${issue.url}|${issue.identifier} ${issue.title}>`
    : `${issue.identifier} ${issue.title}`;
}

export function buildFallbackResearchSynthesis(args: {
  slackThreadEntries: SlackThreadEntries;
  relatedIssues: LinearIssue[];
  searchResults: SearchResults;
}): ResearchSynthesisResult {
  const findings: string[] = [];
  if (args.relatedIssues[0]) {
    findings.push(`関連 issue として ${formatIssueReference(args.relatedIssues[0])} を確認しました。`);
  }
  if (args.searchResults[0]) {
    findings.push(`Web では ${args.searchResults[0].title} を確認しました。`);
  }
  if (findings.length === 0) {
    findings.push("関連情報の洗い出しを開始しました。");
  }

  return {
    findings,
    uncertainties: ["スコープや対処方針の確定が必要なら、この thread で詰めます。"],
    nextActions: [],
  };
}

export function buildResearchIssueDescription(args: {
  sourceMessage: SourceMessageLike;
  synthesis: ResearchSynthesisResult;
}): string {
  return [
    "## Slack source",
    `- channelId: ${args.sourceMessage.channelId}`,
    `- rootThreadTs: ${args.sourceMessage.rootThreadTs}`,
    `- sourceMessageTs: ${args.sourceMessage.messageTs}`,
    "",
    "## 分かったこと",
    extractTopLines(args.synthesis.findings, "まず関連情報の洗い出しを開始しました。"),
    "",
    "## 未確定事項",
    extractTopLines(
      args.synthesis.uncertainties,
      "スコープ・期限・実行順の確定が必要なら control room で確認する。",
    ),
    "",
    "## 次アクション",
    formatResearchNextActions(args.synthesis.nextActions),
    "",
    "## 調べた範囲",
    "- Slack thread context",
    "- Slack recent channel context",
    "- Linear related issues / comments / relations",
    "- Lightweight web search",
  ].join("\n");
}

export function buildResearchComment(args: {
  sourceMessage: SourceMessageLike;
  slackThreadEntries: SlackThreadEntries;
  recentChannelContexts: RecentChannelContexts;
  relatedIssues: LinearIssue[];
  searchResults: SearchResults;
  fetchedPages: FetchedPages;
  synthesis: ResearchSynthesisResult;
}): string {
  const recentContextSummary = args.recentChannelContexts.length > 0
    ? args.recentChannelContexts
      .slice(0, 3)
      .map((context) => (
        `- ${context.rootThreadTs}: ${context.entries.slice(-1)[0]?.text.replace(/\s+/g, " ").slice(0, 120) ?? "(no messages)"}`
      ))
      .join("\n")
    : "- 直近 thread 文脈は取得できませんでした。";

  return [
    "## Evidence",
    "### Slack thread context",
    formatSlackContextSummary(args.slackThreadEntries),
    "",
    "### Related Linear issues",
    formatRelatedIssuesSummary(args.relatedIssues),
    "",
    "### Recent channel context",
    recentContextSummary,
    "",
    "### Web results",
    formatWebSummary(args.searchResults, args.fetchedPages),
  ].join("\n");
}

export function formatAutonomousCreateReply(
  parent: LinearIssue | undefined,
  children: LinearIssue[],
  reason: string,
  usedFallback: boolean,
  options?: { reusedParent?: boolean },
): string {
  const primary = parent ?? children[0];
  const detailLines: string[] = ["次アクション: この thread で進捗・完了・blocked を続けてください。"];
  let includeUrl = true;

  if (reason === "research-first" && parent && children[0]) {
    detailLines.unshift(
      options?.reusedParent
        ? `調査 task: ${buildSlackTargetLabel(children[0])} を既存の親 issue 配下に追加しました。`
        : `調査 task: ${buildSlackTargetLabel(children[0])} を作成しました。`,
    );
  } else {
    const childSummary = formatChildIssueSummaryForSlack(children);
    if (childSummary) {
      detailLines.push(childSummary);
      includeUrl = false;
    }
  }

  if (usedFallback) {
    detailLines.push("補足: 担当未定義の task は暫定で kyaukyuai に寄せています。");
  }

  return formatThreadReplyForSlack({
    headline: "Linear に登録しました。",
    target: primary ? buildSlackTargetLabel(primary) : undefined,
    lines: detailLines,
    url: includeUrl ? primary?.url ?? undefined : undefined,
    maxLines: usedFallback ? 5 : 4,
  });
}

export function formatExistingIssueReply(duplicates: LinearIssue[]): string {
  if (duplicates.length === 1) {
    return formatThreadReplyForSlack({
      headline: "既存の Linear issue を再利用します。",
      target: buildSlackTargetLabel(duplicates[0]),
      lines: ["次アクション: 進捗・完了・blocked はこの thread にそのまま返してください。"],
      url: duplicates[0]?.url ?? undefined,
    });
  }

  const lines = ["既存の Linear issue が見つかったため、新規起票は行いませんでした。"];
  lines.push("候補が複数あるため、必要なら対象 issue を明示してください。");
  for (const issue of duplicates.slice(0, 3)) {
    lines.push(`- ${formatIssueReference(issue)}`);
  }
  return lines.join("\n");
}

export function buildResearchSlackSummary(args: {
  parent: LinearIssue;
  researchChild: LinearIssue;
  reusedParent: boolean;
  synthesis: ResearchSynthesisResult;
  followupChildren?: LinearIssue[];
}): string {
  const lines = [
    `分かったこと: ${truncateSlackText(args.synthesis.findings[0] ?? "まず関連情報の洗い出しを開始しました。", 72)}`,
    `未確定事項: ${truncateSlackText(args.synthesis.uncertainties[0] ?? "スコープや対処方針の確定が必要なら、この thread で詰めます。", 72)}`,
  ];
  if ((args.followupChildren?.length ?? 0) > 0) {
    lines.push(`次アクション: 調査結果をもとに追加 task を ${args.followupChildren!.length} 件作成しました。`);
    const childSummary = formatChildIssueSummaryForSlack(args.followupChildren ?? [], {
      limit: 2,
      titleMaxLength: 32,
    });
    if (childSummary) {
      lines.push(childSummary);
    }
  } else if (args.synthesis.nextActions.length > 0) {
    lines.push(`次アクション: ${args.synthesis.nextActions[0]?.title}`);
  } else {
    lines.push("次アクション: 調査結果をもとに必要なら実行 task を追加します。");
  }

  return formatThreadReplyForSlack({
    headline: "調査内容を Linear に記録しました。",
    target: args.reusedParent
      ? `${buildSlackTargetLabel(args.researchChild, 48)} / 親: ${args.parent.identifier}`
      : buildSlackTargetLabel(args.researchChild, 48),
    lines,
    maxLines: 6,
  });
}
