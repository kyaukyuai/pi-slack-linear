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
import {
  buildSlackTargetLabel,
  composeSlackReply,
  formatSlackIssueListSentence,
  joinSlackSentences,
  truncateSlackText,
} from "../shared/slack-conversation.js";

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

function stripSentenceEnding(text: string): string {
  return text.replace(/[。.!！?？]+$/u, "").trim();
}

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

export function buildExecutionIssueDescription(sourceText: string): string {
  return [
    "## Slack source",
    sourceText,
    "",
    "## 完了条件",
    "- 実行単位で完了できる状態にする",
  ].join("\n");
}

export function buildCorrectedSlackSourceText(originalRequest: string, correctionText: string): string {
  return [
    originalRequest.trim(),
    "",
    "訂正:",
    correctionText.trim(),
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
  parent: (Pick<LinearIssue, "identifier" | "title"> & { url?: string | null }) | undefined,
  children: LinearIssue[],
  reason: string,
  usedFallback: boolean,
  options?: { reusedParent?: boolean; attachedToExistingParent?: boolean },
): string {
  const primary = parent ?? children[0];
  const paragraphs: Array<string | undefined> = [];

  if (reason === "research-first" && parent && children[0]) {
    paragraphs.push(
      joinSlackSentences([
        "この依頼は Linear に登録しておきました。",
        `親は ${buildSlackTargetLabel(parent)} です。`,
        options?.reusedParent
          ? `調査 task として ${buildSlackTargetLabel(children[0])} を既存の親 issue 配下に追加しています。`
          : `調査 task として ${buildSlackTargetLabel(children[0])} を作成しています。`,
      ]),
    );
  } else if (!parent && children.length === 1 && children[0]) {
    paragraphs.push(
      joinSlackSentences([
        "この依頼は Linear に登録しておきました。",
        `対象は ${buildSlackTargetLabel(children[0])} です。`,
      ]),
    );
  } else if (parent && children.length === 1 && children[0]) {
    paragraphs.push(
      joinSlackSentences([
        "この依頼は Linear に登録しておきました。",
        options?.attachedToExistingParent
          ? `親は ${buildSlackTargetLabel(parent)} で、子 task として ${buildSlackTargetLabel(children[0])} を追加しています。`
          : `親は ${buildSlackTargetLabel(parent)} で、子 task として ${buildSlackTargetLabel(children[0])} を作成しています。`,
      ]),
    );
  } else {
    paragraphs.push(
      joinSlackSentences([
        "この依頼は Linear に登録しておきました。",
        primary ? `親は ${buildSlackTargetLabel(primary)} です。` : undefined,
        formatSlackIssueListSentence({
          subject: "子 task は ",
          issues: children,
        }),
      ]),
    );
  }

  paragraphs.push("この thread で進捗・完了・blocked を続けてください。");
  if (usedFallback) {
    paragraphs.push("担当が未定義だった task は、いったん kyaukyuai に寄せています。");
  }
  return composeSlackReply(paragraphs);
}

export function formatExistingIssueReply(
  duplicates: LinearIssue[],
  options?: {
    parent?: Pick<LinearIssue, "identifier" | "title"> & { url?: string | null };
    attachedToParent?: boolean;
  },
): string {
  if (duplicates.length === 1) {
    return composeSlackReply([
      options?.parent
        ? options.attachedToParent
          ? "同じ内容の issue が見つかったので、新規起票はせず既存の issue を親 issue に紐づけ直しました。"
          : "同じ内容の issue が見つかったので、新規起票はせず既存の issue をそのまま使います。"
        : "同じ内容の issue が見つかったので、新規起票はせず既存の issue に寄せます。",
      joinSlackSentences([
        `対象は ${buildSlackTargetLabel(duplicates[0])} です。`,
        options?.parent ? `親は ${buildSlackTargetLabel(options.parent)} です。` : undefined,
      ]),
      "進捗・完了・blocked は、この thread にそのまま返してください。",
    ]);
  }

  return composeSlackReply([
    "同じ内容の issue が複数見つかったため、新規起票はまだ行っていません。",
    "対象にしたい issue があれば、その issue ID を教えてください。候補は次のとおりです。",
    duplicates
      .slice(0, 3)
      .map((issue) => `- ${formatIssueReference(issue)}`)
      .join("\n"),
  ]);
}

export function formatCorrectedExistingIssueReply(
  issue: Pick<LinearIssue, "identifier" | "title"> & { url?: string | null },
): string {
  return composeSlackReply([
    "失礼しました。既存 issue を修正しました。",
    `対象は ${buildSlackTargetLabel(issue)} です。`,
    "進捗・完了・blocked は、この thread にそのまま返してください。",
  ]);
}

export function buildResearchSlackSummary(args: {
  parent: LinearIssue;
  researchChild: LinearIssue;
  reusedParent: boolean;
  synthesis: ResearchSynthesisResult;
  followupChildren?: LinearIssue[];
}): string {
  const paragraphs = [
    joinSlackSentences([
      "調査内容を Linear に残しました。",
      args.reusedParent
        ? `調査 task は ${buildSlackTargetLabel(args.researchChild, 48)} で、親は ${buildSlackTargetLabel(args.parent, 48)} です。`
        : `調査 task は ${buildSlackTargetLabel(args.researchChild, 48)} です。`,
    ]),
    joinSlackSentences([
      `いま分かっているのは、${stripSentenceEnding(truncateSlackText(args.synthesis.findings[0] ?? "まず関連情報の洗い出しを開始しました。", 72))}。`,
      `まだ未確定なのは、${stripSentenceEnding(truncateSlackText(args.synthesis.uncertainties[0] ?? "スコープや対処方針の確定が必要なら、この thread で詰めます。", 72))}。`,
    ]),
  ];
  if ((args.followupChildren?.length ?? 0) > 0) {
    paragraphs.push(
      joinSlackSentences([
        `次に進める候補として ${args.followupChildren!.length} 件の task を追加しています。`,
        formatSlackIssueListSentence({
          subject: "子 task は ",
          issues: args.followupChildren ?? [],
          limit: 2,
          titleMaxLength: 32,
        }),
      ]),
    );
  } else if (args.synthesis.nextActions.length > 0) {
    paragraphs.push(`次に進める候補は「${args.synthesis.nextActions[0]?.title}」です。`);
  } else {
    paragraphs.push("必要になれば、この thread から実行 task を追加できます。");
  }

  return composeSlackReply(paragraphs);
}
