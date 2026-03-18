import {
  getLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
} from "../../lib/linear.js";
import type { IntakeLedgerEntry } from "../../state/manager-state-contract.js";
import { getSlackThreadContext } from "../../lib/slack-context.js";
import { issueMatchesCompletedState } from "../review/risk.js";

type UpdateSignal = "progress" | "completed" | "blocked";

interface ThreadLikeMessage {
  channelId: string;
  rootThreadTs: string;
  text: string;
}

interface ThreadIssueCandidates {
  candidateIds: string[];
  childIssueIds: Set<string>;
  parentIssueIds: Set<string>;
  latestEntryIssueIds: string[];
  lastResolvedIssueId?: string;
  latestFocusIssueId?: string;
}

interface ScoredIssueTarget {
  issue: LinearIssue;
  score: number;
  signalMatches: number;
}

interface RecentFocusText {
  type: "user" | "assistant";
  text: string;
}

export interface IssueSelectionCandidate {
  issueId: string;
  title?: string;
  issueUrl?: string | null;
  latestActionLabel?: string;
  focusReason?: string;
}

export interface IssueTargetResolution {
  selectedIssueIds: string[];
  candidates: IssueSelectionCandidate[];
  reason: "explicit" | "thread" | "missing" | "ambiguous";
}

const SIGNAL_TERM_STOPWORDS = new Set([
  "進捗",
  "完了",
  "更新",
  "確認",
  "対応",
  "調査",
  "整理",
  "作業",
  "原因",
  "必要",
  "共有",
  "待ち",
  "本日中",
  "今日",
  "明日",
  "状態",
  "issue",
  "task",
  "linear",
]);

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function trimJapaneseParticles(text: string): string {
  return text.replace(/(?:は|を|が|に|で|と|へ|も|の)+$/u, "").trim();
}

export function extractIssueIdentifiers(text: string): string[] {
  return unique(
    Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
      .map((match) => match[1] ?? "")
      .filter(Boolean),
  );
}

function collectEntryIssueIds(entry: IntakeLedgerEntry): string[] {
  return unique([
    entry.lastResolvedIssueId,
    entry.parentIssueId,
    ...entry.childIssueIds,
  ].filter(Boolean)) as string[];
}

function findThreadEntries(
  intakeLedger: IntakeLedgerEntry[],
  message: Pick<ThreadLikeMessage, "channelId" | "rootThreadTs">,
): IntakeLedgerEntry[] {
  return intakeLedger.filter((entry) => (
    entry.sourceChannelId === message.channelId && entry.sourceThreadTs === message.rootThreadTs
  ));
}

function collectThreadIssueCandidates(
  intakeLedger: IntakeLedgerEntry[],
  message: Pick<ThreadLikeMessage, "channelId" | "rootThreadTs">,
): ThreadIssueCandidates {
  const threadEntries = [...findThreadEntries(intakeLedger, message)].reverse();
  const latestEntry = threadEntries[0];
  const childIssueIds = new Set(
    threadEntries.flatMap((entry) => entry.childIssueIds ?? []).filter(Boolean),
  );
  const parentIssueIds = new Set(
    threadEntries.map((entry) => entry.parentIssueId).filter(Boolean) as string[],
  );

  return {
    candidateIds: unique(threadEntries.flatMap((entry) => collectEntryIssueIds(entry))),
    childIssueIds,
    parentIssueIds,
    latestEntryIssueIds: latestEntry ? collectEntryIssueIds(latestEntry) : [],
    lastResolvedIssueId: latestEntry?.lastResolvedIssueId
      ?? threadEntries.find((entry) => entry.lastResolvedIssueId)?.lastResolvedIssueId,
    latestFocusIssueId: latestEntry?.issueFocusHistory?.slice(-1)[0]?.issueId,
  };
}

function formatLatestActionLabel(issue: LinearIssue): string | undefined {
  if (!issue.latestActionKind) return undefined;
  if (issue.latestActionKind === "progress") return "進捗";
  if (issue.latestActionKind === "blocked") return "blocked";
  if (issue.latestActionKind === "slack-source") return "Slack source";
  return "その他";
}

function describeFocusReason(issue: LinearIssue, candidates: ThreadIssueCandidates): string | undefined {
  if (candidates.latestFocusIssueId === issue.identifier) return "直近 thread focus";
  if (candidates.lastResolvedIssueId === issue.identifier) return "直近解決対象";
  if (candidates.latestEntryIssueIds.includes(issue.identifier)) return "最新 intake entry";
  if (candidates.childIssueIds.has(issue.identifier)) return "thread child issue";
  return undefined;
}

function deriveStatusFocusText(text: string): string {
  let focus = text.trim();
  focus = focus.replace(/^<@[^>]+>\s*/, "");
  focus = focus.replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ");
  focus = focus.replace(
    /(進捗です|進捗|完了しました|完了した|終わりました|終わった|blocked です|blocked|ブロックされています|ブロックです|ブロック|詰まっています|詰まってます|対応中です|対応中|やっています|着手しました|着手中|です)/gi,
    " ",
  );
  focus = focus.replace(/[。！!？?,、]+/g, " ");
  focus = focus.replace(/\s+/g, " ").trim();
  return trimJapaneseParticles(focus);
}

function tokenizeForMatching(text: string): string[] {
  return normalizeText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => trimJapaneseParticles(token))
    .filter((token) => token.length >= 2);
}

function extractSignalTerms(text: string): string[] {
  const normalized = text
    .replace(/[。！!？?,、/()（）[\]{}「」『』:：]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  return unique(
    normalized
      .split(/\s+/)
      .flatMap((segment) => segment.split(/[ぁ-ん]+/))
      .map((token) => trimJapaneseParticles(token).toLowerCase())
      .filter((token) => token.length >= 2)
      .filter((token) => !SIGNAL_TERM_STOPWORDS.has(token)),
  ).slice(0, 8);
}

function countLooseSignalOverlap(leftTerms: string[], rightTerms: string[]): number {
  let overlap = 0;
  for (const left of leftTerms) {
    if (rightTerms.some((right) => right === left || right.includes(left) || left.includes(right))) {
      overlap += 1;
    }
  }
  return overlap;
}

function countTokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenizeForMatching(left));
  const rightTokens = new Set(tokenizeForMatching(right));
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

async function loadRecentThreadFocusTexts(
  workspaceDir: string,
  message: Pick<ThreadLikeMessage, "channelId" | "rootThreadTs">,
): Promise<RecentFocusText[]> {
  const context = await getSlackThreadContext(
    workspaceDir,
    message.channelId,
    message.rootThreadTs,
    12,
  ).catch(() => undefined);
  if (!context) return [];

  return context.entries
    .filter((entry): entry is (typeof context.entries)[number] & { type: "user" | "assistant" } => (
      entry.type === "user" || entry.type === "assistant"
    ))
    .slice(-6)
    .map((entry) => ({
      type: entry.type,
      text: deriveStatusFocusText(entry.text),
    }))
    .filter((entry) => entry.text.length >= 2);
}

function getRecentLinearCommentBodies(issue: LinearIssue, limit = 3): string[] {
  return (issue.comments ?? [])
    .slice()
    .sort((left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""))
    .slice(0, limit)
    .map((comment) => deriveStatusFocusText(comment.body))
    .filter((text) => text.length >= 2);
}

function scoreIssueTargetCandidate(
  issue: LinearIssue,
  focusText: string,
  candidates: ThreadIssueCandidates,
  kind: UpdateSignal,
  recentFocusTexts: RecentFocusText[],
): ScoredIssueTarget {
  let score = 0;
  const normalizedIssueTitle = normalizeText(issue.title);
  const normalizedFocus = normalizeText(focusText);
  const focusTerms = extractSignalTerms(focusText);
  const titleSignalMatches = countLooseSignalOverlap(focusTerms, extractSignalTerms(issue.title));
  const commentSignalMatches = Math.max(
    0,
    ...getRecentLinearCommentBodies(issue).map((commentText) => (
      countLooseSignalOverlap(focusTerms, extractSignalTerms(commentText))
    )),
  );
  const recentSlackSignalMatches = Math.max(
    0,
    ...recentFocusTexts.map((recentFocus) => (
      countLooseSignalOverlap(focusTerms, extractSignalTerms(recentFocus.text))
    )),
  );
  const signalMatches = Math.max(titleSignalMatches, commentSignalMatches, recentSlackSignalMatches);

  if (candidates.childIssueIds.has(issue.identifier)) {
    score += 22;
  }
  if (candidates.latestFocusIssueId === issue.identifier) {
    score += 28;
  }
  if (candidates.latestEntryIssueIds.includes(issue.identifier)) {
    score += 16;
  }
  if (candidates.parentIssueIds.has(issue.identifier) && candidates.childIssueIds.size > 0) {
    score -= 12;
  }

  if (normalizedFocus.length >= 2) {
    if (normalizedIssueTitle === normalizedFocus) {
      score += 60;
    } else if (
      normalizedFocus.length >= 4
      && (normalizedIssueTitle.includes(normalizedFocus) || normalizedFocus.includes(normalizedIssueTitle))
    ) {
      score += 35;
    } else {
      score += Math.min(countTokenOverlap(issue.title, focusText) * 12, 24);
    }
  }

  score += titleSignalMatches * 16;
  score += commentSignalMatches * 10;
  score += recentSlackSignalMatches * 6;

  for (const recentFocus of recentFocusTexts) {
    if (!recentFocus.text) continue;
    const normalizedRecent = normalizeText(recentFocus.text);
    const weight = recentFocus.type === "assistant" ? 5 : 10;
    if (
      normalizedRecent.length >= 3
      && (normalizedIssueTitle.includes(normalizedRecent) || normalizedRecent.includes(normalizedIssueTitle))
    ) {
      score += recentFocus.type === "assistant" ? 8 : 14;
      continue;
    }
    score += Math.min(
      countTokenOverlap(issue.title, recentFocus.text) * weight,
      recentFocus.type === "assistant" ? 10 : 18,
    );
  }

  for (const commentText of getRecentLinearCommentBodies(issue)) {
    const normalizedComment = normalizeText(commentText);
    if (normalizedComment.length >= 3 && (normalizedComment.includes(normalizedFocus) || normalizedFocus.includes(normalizedComment))) {
      score += 12;
      continue;
    }
    score += Math.min(countTokenOverlap(commentText, focusText) * 9, 18);
    for (const recentFocus of recentFocusTexts) {
      score += Math.min(
        countTokenOverlap(commentText, recentFocus.text) * (recentFocus.type === "assistant" ? 3 : 4),
        8,
      );
    }
  }

  if (candidates.lastResolvedIssueId === issue.identifier) {
    score += 10;
  }

  const completedState = issueMatchesCompletedState(issue);
  if (kind === "completed" && completedState) {
    score -= 35;
  }
  if ((kind === "progress" || kind === "blocked") && completedState) {
    score -= 45;
  }
  if (
    (kind === "progress" || kind === "blocked" || kind === "completed")
    && candidates.childIssueIds.size > 0
    && candidates.parentIssueIds.has(issue.identifier)
  ) {
    score -= 10;
  }
  if ((kind === "progress" || kind === "blocked") && candidates.childIssueIds.has(issue.identifier)) {
    score += 10;
  }
  if (kind === "blocked" && issue.state?.name?.toLowerCase().includes("block")) {
    score += 4;
  }
  if (kind === "progress" && issue.latestActionKind === "progress") {
    score += 8;
  }
  if (kind === "blocked" && issue.latestActionKind === "blocked") {
    score += 10;
  }
  if (kind === "completed" && (issue.latestActionKind === "progress" || issue.latestActionKind === "blocked")) {
    score += 4;
  }

  if (focusTerms.length > 0 && signalMatches === 0) {
    score -= 20;
  }

  return {
    issue,
    score,
    signalMatches,
  };
}

export async function resolveIssueTargetsFromThread(
  intakeLedger: IntakeLedgerEntry[],
  message: ThreadLikeMessage,
  kind: UpdateSignal,
  workspaceDir: string,
  env: LinearCommandEnv,
): Promise<IssueTargetResolution> {
  const explicitIssueIds = extractIssueIdentifiers(message.text);
  if (explicitIssueIds.length > 0) {
    return {
      selectedIssueIds: explicitIssueIds,
      candidates: explicitIssueIds.map((issueId) => ({ issueId })),
      reason: "explicit",
    };
  }

  const candidates = collectThreadIssueCandidates(intakeLedger, message);
  if (candidates.candidateIds.length === 0) {
    return {
      selectedIssueIds: [],
      candidates: [],
      reason: "missing",
    };
  }

  if (candidates.candidateIds.length === 1) {
    return {
      selectedIssueIds: candidates.candidateIds,
      candidates: candidates.candidateIds.map((issueId) => ({ issueId })),
      reason: "thread",
    };
  }

  const focusText = deriveStatusFocusText(message.text);
  const focusTerms = extractSignalTerms(focusText);
  const recentFocusTexts = await loadRecentThreadFocusTexts(workspaceDir, message);
  const candidateIssues = (await Promise.all(
    candidates.candidateIds.map(async (issueId) => {
      try {
        const issue = await getLinearIssue(issueId, env, undefined, { includeComments: true });
        return scoreIssueTargetCandidate(issue, focusText, candidates, kind, recentFocusTexts);
      } catch {
        return undefined;
      }
    }),
  )).filter(Boolean) as ScoredIssueTarget[];

  if (candidateIssues.length === 0) {
    return {
      selectedIssueIds: [],
      candidates: candidates.candidateIds.map((issueId) => ({ issueId })),
      reason: "ambiguous",
    };
  }

  candidateIssues.sort((left, right) => right.score - left.score);
  const top = candidateIssues[0];
  const second = candidateIssues[1];
  const topScore = top?.score ?? 0;
  const secondScore = second?.score ?? Number.NEGATIVE_INFINITY;
  const requiredSignalMatches = focusTerms.length >= 2 ? 2 : focusTerms.length === 1 ? 1 : 0;
  const hasStrongSignalMatch = requiredSignalMatches === 0 || (top?.signalMatches ?? 0) >= requiredSignalMatches;

  if (top && topScore >= 24 && topScore - secondScore >= 8 && hasStrongSignalMatch) {
    return {
      selectedIssueIds: [top.issue.identifier],
      candidates: candidateIssues.map((item) => ({
        issueId: item.issue.identifier,
        title: item.issue.title,
        issueUrl: item.issue.url,
        latestActionLabel: formatLatestActionLabel(item.issue),
        focusReason: describeFocusReason(item.issue, candidates),
      })),
      reason: "thread",
    };
  }

  return {
    selectedIssueIds: [],
    candidates: candidateIssues.map((item) => ({
      issueId: item.issue.identifier,
      title: item.issue.title,
      issueUrl: item.issue.url,
      latestActionLabel: formatLatestActionLabel(item.issue),
      focusReason: describeFocusReason(item.issue, candidates),
    })),
    reason: "ambiguous",
  };
}

export function formatIssueSelectionReply(
  kind: UpdateSignal,
  issues: IssueSelectionCandidate[],
): string {
  const prefix = kind === "completed"
    ? "完了を反映したい issue を特定できませんでした。"
    : kind === "blocked"
      ? "blocked 状態を反映したい issue を特定できませんでした。"
      : "進捗を反映したい issue を特定できませんでした。";

  const lines = [prefix];
  if (issues.length > 0) {
    lines.push("対象の issue ID を 1 つ指定してください。候補:");
    for (const issue of issues.slice(0, 5)) {
      const issueLabel = issue.issueUrl ? `<${issue.issueUrl}|${issue.issueId}>` : issue.issueId;
      lines.push(
        `- ${issueLabel}${issue.title ? ` / ${issue.title}` : ""}${issue.latestActionLabel ? ` / 最新: ${issue.latestActionLabel}` : ""}${issue.focusReason ? ` / 理由: ${issue.focusReason}` : ""}`,
      );
    }
    lines.push("当てはまるものが無ければ `新規 task` と返してください。");
  } else {
    lines.push("同じ thread に紐づく issue が無かったため、`AIC-123` のように issue ID を含めてください。");
  }
  return lines.join("\n");
}
