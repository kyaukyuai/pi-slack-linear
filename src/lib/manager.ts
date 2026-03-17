import type { AppConfig } from "./config.js";
import {
  addLinearComment,
  addLinearProgressComment,
  addLinearRelation,
  createManagedLinearIssue,
  createManagedLinearIssueBatch,
  getLinearIssue,
  listRiskyLinearIssues,
  markLinearIssueBlocked,
  searchLinearIssues,
  updateLinearIssueState,
  type LinearIssue,
} from "./linear.js";
import {
  loadFollowupsLedger,
  loadIntakeLedger,
  loadManagerPolicy,
  loadOwnerMap,
  loadPlanningLedger,
  saveFollowupsLedger,
  saveIntakeLedger,
  savePlanningLedger,
  type FollowupLedgerEntry,
  type IntakeLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type OwnerMapEntry,
  type PlanningLedgerEntry,
} from "./manager-state.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import type { SystemPaths } from "./system-workspace.js";
import { webFetchUrl, webSearchFetch } from "./web-research.js";

export type ManagerMessageKind = "request" | "progress" | "completed" | "blocked" | "conversation";
export type ManagerReviewKind = "morning-review" | "evening-review" | "weekly-review" | "heartbeat";
export type ClarificationNeed = "scope" | "due_date" | "execution_plan";

export interface ManagerSlackMessage {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId: string;
  text: string;
}

export interface ManagerHandleResult {
  handled: boolean;
  reply?: string;
}

export interface RiskAssessment {
  issue: LinearIssue;
  riskCategories: string[];
  ownerMissing: boolean;
  dueMissing: boolean;
  blocked: boolean;
  businessDaysSinceUpdate: number;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RESEARCH_PATTERN = /(調査|確認|検証|比較|リサーチ|洗い出し|調べ)/i;
const REQUEST_PATTERN =
  /(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|しておいて|お願い|お願いします|対応して|やっておいて|進めて|進めておいて)/i;
const COMPLETED_PATTERN = /(完了|終わった|終わりました|done|closed?|完了した)/i;
const BLOCKED_PATTERN = /(blocked|ブロック|詰まって|進められない|待ち)/i;
const PROGRESS_PATTERN = /(進捗|対応中|やっています|started|着手|進めています)/i;
const URGENCY_WITHOUT_EXACT_DUE_PATTERN = /(急ぎ|至急|優先|早め|今週|来週|今月|来月|月内|リリース|今期)/i;
const VAGUE_REFERENCE_PATTERN = /(これ|それ|あれ|例の|この件|その件|あの件|やつ)/i;
const GENERIC_TITLE_PATTERN = /^(対応|確認|修正|作業|依頼|タスク|issue|イシュー|ticket|チケット)$/i;
const AMBIGUOUS_EXECUTION_PATTERN = /(進めておいて|進めて|よしなに|一式|まとめて|諸々|全般|いろいろ)/i;
const ACTIONABLE_RESEARCH_PATTERN = /(確認|修正|対応|実装|調査|整理|洗い出し|作成|更新|共有|再現|検証|比較)/i;
const LIST_MARKER_PATTERN = /^\s*(?:[-*・•]\s+|\d+[.)]\s+)/;
const LIST_HEADING_PATTERN = /^(?:タスク|todo|issue|イシュー)?\s*一覧$/i;

interface ParsedTaskSegment {
  raw: string;
  title: string;
  dueDate?: string;
  assignee?: string;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function toJstDate(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

function stripLeadingListMarker(text: string): string {
  return text.replace(LIST_MARKER_PATTERN, "").trim();
}

function getListHeading(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return undefined;

  const first = stripLeadingListMarker(lines[0] ?? "");
  const second = lines[1] ?? "";
  if (!LIST_MARKER_PATTERN.test(second)) return undefined;

  const heading = first
    .replace(/^<@[^>]+>\s*/, "")
    .replace(/[。！!？?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!heading) return undefined;
  if (LIST_HEADING_PATTERN.test(heading) || heading.endsWith("一覧")) {
    return heading;
  }
  return undefined;
}

export function fingerprintText(text: string): string {
  return normalizeText(text)
    .replace(/(linear|issue|イシュー|ticket|チケット|todo|タスク|登録|追加|作成|作って|しておいて|お願い|お願いします)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyManagerSignal(text: string): ManagerMessageKind {
  const normalized = text.trim();
  if (!normalized) return "conversation";
  if (BLOCKED_PATTERN.test(normalized)) return "blocked";
  if (COMPLETED_PATTERN.test(normalized)) return "completed";
  if (PROGRESS_PATTERN.test(normalized)) return "progress";
  if (RESEARCH_PATTERN.test(normalized)) return "request";
  if (REQUEST_PATTERN.test(normalized)) return "request";
  return "conversation";
}

export function needsResearchTask(text: string): boolean {
  return RESEARCH_PATTERN.test(text);
}

function extractInlineTaskSegments(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(?:作業|対応|タスク)(?:は|を)?\s*(.+?)(?:\s*)に分けて/i);
  if (!match?.[1]) return [];

  return unique(
    match[1]
      .split(/(?:、|,|と|および|及び)/)
      .map((segment) => deriveIssueTitle(segment))
      .filter((segment) => segment.length >= 2),
  );
}

export function extractTaskSegments(text: string): string[] {
  const listHeading = getListHeading(text);
  const bulletLines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => LIST_MARKER_PATTERN.test(line))
    .map((line) => stripLeadingListMarker(line))
    .filter(Boolean);

  if (bulletLines.length >= 2) {
    const filteredBulletLines = listHeading
      ? bulletLines.filter((line, index) => !(index === 0 && normalizeText(line) === normalizeText(listHeading)))
      : bulletLines;
    return Array.from(new Set(filteredBulletLines));
  }

  const inlineSegments = extractInlineTaskSegments(text);
  if (inlineSegments.length >= 2) {
    return inlineSegments;
  }

  const sentenceLike = text
    .split(/[。\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment.length >= 6);

  if (sentenceLike.length >= 2) {
    return Array.from(new Set(sentenceLike));
  }

  return [];
}

export function deriveIssueTitle(text: string): string {
  let title = text.trim();
  title = title.replace(/^<@[^>]+>\s*/, "");
  title = title.replace(LIST_MARKER_PATTERN, "");
  title = title.replace(/(の)?(タスク|issue|Issue|イシュー|ticket|チケット)(を)?/g, " ");
  title = title.replace(/(しておいて|やっておいて|追加して|作成して|作って|登録して|おいて|お願い(します)?|対応して|進めておいて|進めて)/g, " ");
  title = title.replace(/[。！!？?]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/を$/, "");
  return title || "Slack からの依頼";
}

function deriveResearchTitle(text: string): string {
  const normalized = text.replace(/(を)?(調査|確認|検証|比較|リサーチ|洗い出し|調べ)(しておいて|して|お願いします|お願い)?/g, " ");
  const title = deriveIssueTitle(normalized);
  return title || deriveIssueTitle(text);
}

function summarizeParentTitleFromSegments(segments: string[]): string | undefined {
  const parsedSegments = segments
    .map((segment) => parseTaskSegment(segment))
    .map((segment) => segment.title)
    .filter(Boolean);

  if (parsedSegments.length === 0) return undefined;
  if (parsedSegments.length === 1) return parsedSegments[0];
  return `${parsedSegments[0]} ほか${parsedSegments.length - 1}件`;
}

function derivePlanningTitle(text: string, research: boolean, segments: string[]): string {
  const listHeading = getListHeading(text);
  if (listHeading && segments.length >= 2) {
    if (LIST_HEADING_PATTERN.test(listHeading) || listHeading === "一覧") {
      return summarizeParentTitleFromSegments(segments) ?? listHeading;
    }
    return listHeading;
  }
  if (segments.length >= 3 && text.split("\n").some((line) => LIST_MARKER_PATTERN.test(line))) {
    return summarizeParentTitleFromSegments(segments) ?? "Slack から取り込んだタスク一覧";
  }
  return research ? deriveResearchTitle(text) : deriveIssueTitle(text);
}

function chooseExistingResearchParent(duplicates: LinearIssue[], baseTitle: string): LinearIssue | undefined {
  if (duplicates.length === 0) return undefined;

  const normalizedBase = normalizeText(baseTitle);
  return [...duplicates]
    .sort((left, right) => {
      const leftTitle = normalizeText(left.title);
      const rightTitle = normalizeText(right.title);
      const leftIsResearch = needsResearchTask(left.title);
      const rightIsResearch = needsResearchTask(right.title);
      const leftIncludesBase = leftTitle.includes(normalizedBase) || normalizedBase.includes(leftTitle);
      const rightIncludesBase = rightTitle.includes(normalizedBase) || normalizedBase.includes(rightTitle);

      const leftScore =
        (leftIsResearch ? 0 : 10)
        + (leftIncludesBase ? 4 : 0)
        - leftTitle.length / 100;
      const rightScore =
        (rightIsResearch ? 0 : 10)
        + (rightIncludesBase ? 4 : 0)
        - rightTitle.length / 100;

      return rightScore - leftScore;
    })[0];
}

export function isComplexRequest(text: string): boolean {
  return extractTaskSegments(text).length >= 2 || text.length >= 48;
}

export function detectClarificationNeeds(text: string, now = new Date()): ClarificationNeed[] {
  const needs: ClarificationNeed[] = [];
  const title = deriveIssueTitle(text);
  const dueDate = extractDueDate(text, now);
  const hasSegments = extractTaskSegments(text).length >= 2;

  if (VAGUE_REFERENCE_PATTERN.test(text) || title === "Slack からの依頼" || GENERIC_TITLE_PATTERN.test(title)) {
    needs.push("scope");
  }

  if (!dueDate && URGENCY_WITHOUT_EXACT_DUE_PATTERN.test(text)) {
    needs.push("due_date");
  }

  if ((isComplexRequest(text) || AMBIGUOUS_EXECUTION_PATTERN.test(text)) && !hasSegments && !needsResearchTask(text)) {
    needs.push("execution_plan");
  }

  return unique(needs);
}

export function formatClarificationReply(title: string, needs: ClarificationNeed[]): string {
  const lines = ["起票前に確認したい点があります。", `- 対象: ${title}`];

  if (needs.includes("scope")) {
    lines.push("- 何をどこまで対応するタスクか、対象をもう少し具体化してください。");
  }
  if (needs.includes("due_date")) {
    lines.push("- 期限を確認したいです。いつまでに完了したいか教えてください。例: 2026-03-20 / 今日中 / 明日");
  }
  if (needs.includes("execution_plan")) {
    lines.push("- 進め方を固めたいです。完了条件か、分けたい作業を 1-3 点で教えてください。");
  }

  lines.push("- 返答をもらえれば、その内容を取り込んで Linear に起票します。");
  return lines.join("\n");
}

function extractDueDate(text: string, now = new Date()): string | undefined {
  const normalized = text.trim();
  const explicit = normalized.match(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (explicit) {
    return `${explicit[1]}-${explicit[2]}-${explicit[3]}`;
  }

  const jstNow = toJstDate(now);
  const year = jstNow.getUTCFullYear();
  const month = jstNow.getUTCMonth();
  const day = jstNow.getUTCDate();

  if (/明後日/.test(normalized)) {
    return new Date(Date.UTC(year, month, day + 2)).toISOString().slice(0, 10);
  }
  if (/明日/.test(normalized)) {
    return new Date(Date.UTC(year, month, day + 1)).toISOString().slice(0, 10);
  }
  if (/今日/.test(normalized)) {
    return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  }

  return undefined;
}

function extractGlobalDueDate(text: string, now = new Date()): string | undefined {
  const nonListText = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !LIST_MARKER_PATTERN.test(line))
    .join("\n");

  if (!nonListText) return undefined;
  return extractDueDate(nonListText, now);
}

function parseTaskSegment(text: string, now = new Date()): ParsedTaskSegment {
  let raw = stripLeadingListMarker(text.trim());
  let metadataText: string | undefined;
  const metadataMatch = raw.match(/\s*[（(]([^()（）]+)[)）]\s*$/);
  if (metadataMatch && metadataMatch.index != null) {
    metadataText = metadataMatch[1]?.trim();
    raw = raw.slice(0, metadataMatch.index).trim();
  }

  let dueDate: string | undefined;
  let assignee: string | undefined;

  for (const part of (metadataText ?? "").split(/[、,，]/).map((value) => value.trim()).filter(Boolean)) {
    const assigneeMatch = part.match(/^担当[:：]\s*(.+)$/);
    if (assigneeMatch?.[1]) {
      assignee = assigneeMatch[1].trim();
      continue;
    }

    const dueMatch = part.match(/^期限[:：]\s*(.+)$/);
    if (dueMatch?.[1]) {
      const rawDue = dueMatch[1].trim();
      if (rawDue !== "未定") {
        dueDate = extractDueDate(rawDue, now) ?? dueDate;
      }
    }
  }

  return {
    raw: text,
    title: deriveIssueTitle(raw),
    dueDate,
    assignee,
  };
}

export function chooseOwner(text: string, ownerMap: OwnerMap): { entry: OwnerMapEntry; resolution: "mapped" | "fallback" } {
  const normalized = normalizeText(text);
  let bestMatch: { entry: OwnerMapEntry; score: number } | undefined;

  for (const entry of ownerMap.entries) {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (normalized.includes(keyword.toLowerCase())) score += 2;
    }
    for (const domain of entry.domains) {
      if (normalized.includes(domain.toLowerCase())) score += 1;
    }
    if (score === 0) continue;

    if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && entry.primary)) {
      bestMatch = { entry, score };
    }
  }

  if (bestMatch) {
    return { entry: bestMatch.entry, resolution: "mapped" };
  }

  const fallback = ownerMap.entries.find((entry) => entry.id === ownerMap.defaultOwner) ?? ownerMap.entries[0];
  if (!fallback) {
    throw new Error("owner-map.json does not define any owners");
  }
  if (ownerMap.entries.length === 1 && fallback.id === ownerMap.defaultOwner) {
    return { entry: fallback, resolution: "mapped" };
  }
  return { entry: fallback, resolution: "fallback" };
}

function formatSourceComment(message: ManagerSlackMessage, reason: string): string {
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

function findPendingClarification(
  intakeLedger: IntakeLedgerEntry[],
  message: Pick<ManagerSlackMessage, "channelId" | "rootThreadTs">,
): IntakeLedgerEntry | undefined {
  return [...intakeLedger]
    .reverse()
    .find((entry) => entry.sourceChannelId === message.channelId
      && entry.sourceThreadTs === message.rootThreadTs
      && entry.status === "needs-clarification");
}

function buildIntakeKey(entry: Pick<IntakeLedgerEntry, "sourceChannelId" | "sourceThreadTs" | "messageFingerprint">): string {
  return `${entry.sourceChannelId}:${entry.sourceThreadTs}:${entry.messageFingerprint}`;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeRelationType(type: string | null | undefined): string {
  return (type ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function extractIssueIdentifiers(text: string): string[] {
  return unique(Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)).map((match) => match[1] ?? "").filter(Boolean));
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
  message: Pick<ManagerSlackMessage, "channelId" | "rootThreadTs">,
): IntakeLedgerEntry[] {
  return intakeLedger.filter((entry) => entry.sourceChannelId === message.channelId && entry.sourceThreadTs === message.rootThreadTs);
}

interface ThreadIssueCandidates {
  candidateIds: string[];
  childIssueIds: Set<string>;
  parentIssueIds: Set<string>;
  latestEntryIssueIds: string[];
  lastResolvedIssueId?: string;
}

function collectThreadIssueCandidates(
  intakeLedger: IntakeLedgerEntry[],
  message: Pick<ManagerSlackMessage, "channelId" | "rootThreadTs">,
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
    lastResolvedIssueId: threadEntries.find((entry) => entry.lastResolvedIssueId)?.lastResolvedIssueId,
  };
}

function trimJapaneseParticles(text: string): string {
  return text.replace(/(?:は|を|が|に|で|と|へ|も|の)+$/u, "").trim();
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

function scoreIssueTargetCandidate(
  issue: LinearIssue,
  focusText: string,
  candidates: ThreadIssueCandidates,
): number {
  let score = 0;
  const normalizedIssueTitle = normalizeText(issue.title);
  const normalizedFocus = normalizeText(focusText);

  if (candidates.lastResolvedIssueId === issue.identifier) {
    score += 20;
  }
  if (candidates.childIssueIds.has(issue.identifier)) {
    score += 15;
  }
  if (candidates.parentIssueIds.has(issue.identifier) && candidates.childIssueIds.size > 0) {
    score -= 5;
  }
  if (candidates.latestEntryIssueIds.includes(issue.identifier)) {
    score += 4;
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

  return score;
}

async function resolveIssueTargetsFromThread(
  intakeLedger: IntakeLedgerEntry[],
  message: Pick<ManagerSlackMessage, "channelId" | "rootThreadTs" | "text">,
  env: Record<string, string | undefined>,
): Promise<{ issueIds: string[]; reason: "explicit" | "thread" | "missing" | "ambiguous" }> {
  const explicitIssueIds = extractIssueIdentifiers(message.text);
  if (explicitIssueIds.length > 0) {
    return {
      issueIds: explicitIssueIds,
      reason: "explicit",
    };
  }

  const candidates = collectThreadIssueCandidates(intakeLedger, message);
  if (candidates.candidateIds.length === 0) {
    return {
      issueIds: [],
      reason: "missing",
    };
  }

  if (candidates.candidateIds.length === 1) {
    return {
      issueIds: candidates.candidateIds,
      reason: "thread",
    };
  }

  const focusText = deriveStatusFocusText(message.text);
  const candidateIssues = (await Promise.all(
    candidates.candidateIds.map(async (issueId) => {
      try {
        const issue = await getLinearIssue(issueId, env);
        return {
          issue,
          score: scoreIssueTargetCandidate(issue, focusText, candidates),
        };
      } catch {
        return undefined;
      }
    }),
  )).filter(Boolean) as Array<{ issue: LinearIssue; score: number }>;

  if (candidateIssues.length === 0) {
    return {
      issueIds: candidates.candidateIds,
      reason: "ambiguous",
    };
  }

  candidateIssues.sort((left, right) => right.score - left.score);
  const top = candidateIssues[0];
  const second = candidateIssues[1];
  const topScore = top?.score ?? 0;
  const secondScore = second?.score ?? Number.NEGATIVE_INFINITY;

  if (top && topScore >= 20 && topScore - secondScore >= 6) {
    return {
      issueIds: [top.issue.identifier],
      reason: "thread",
    };
  }

  return {
    issueIds: candidateIssues.map((item) => item.issue.identifier),
    reason: "ambiguous",
  };
}

function formatIssueSelectionReply(kind: Exclude<ManagerMessageKind, "conversation" | "request">, issueIds: string[]): string {
  const prefix = kind === "completed"
    ? "完了を反映したい issue を特定できませんでした。"
    : kind === "blocked"
      ? "blocked 状態を反映したい issue を特定できませんでした。"
      : "進捗を反映したい issue を特定できませんでした。";

  const lines = [prefix];
  if (issueIds.length > 0) {
    lines.push("対象の issue ID を 1 つ指定してください。候補:");
    for (const issueId of issueIds.slice(0, 5)) {
      lines.push(`- ${issueId}`);
    }
  } else {
    lines.push("同じ thread に紐づく issue が無かったため、`AIC-123` のように issue ID を含めてください。");
  }
  return lines.join("\n");
}

function formatStatusSourceComment(message: ManagerSlackMessage, heading: string): string {
  return [
    heading,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}

function upsertThreadIntakeEntry(
  intakeLedger: IntakeLedgerEntry[],
  message: Pick<ManagerSlackMessage, "channelId" | "rootThreadTs" | "messageTs" | "text">,
  patch: Partial<IntakeLedgerEntry>,
  now: Date,
): IntakeLedgerEntry[] {
  const threadEntries = findThreadEntries(intakeLedger, message);
  const latest = threadEntries[threadEntries.length - 1];

  if (!latest) {
    return [
      ...intakeLedger,
      {
        sourceChannelId: message.channelId,
        sourceThreadTs: message.rootThreadTs,
        sourceMessageTs: message.messageTs,
        messageFingerprint: fingerprintText(message.text) || message.messageTs,
        childIssueIds: [],
        status: patch.status ?? "created",
        clarificationReasons: [],
        originalText: message.text,
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
        ...patch,
      },
    ];
  }

  return intakeLedger.map((entry) => entry === latest
    ? {
        ...entry,
        ...patch,
        updatedAt: nowIso(now),
      }
    : entry);
}

function formatSlackContextSummary(entries: Awaited<ReturnType<typeof getSlackThreadContext>>["entries"]): string {
  if (entries.length === 0) {
    return "- thread 内の追加文脈は見つかりませんでした。";
  }

  return entries
    .slice(-8)
    .map((entry) => `- [${entry.type}] ${entry.text.replace(/\s+/g, " ").slice(0, 180)}`)
    .join("\n");
}

function formatRelatedIssuesSummary(issues: LinearIssue[]): string {
  if (issues.length === 0) {
    return "- 関連 issue は見つかりませんでした。";
  }

  return issues.slice(0, 5).map((issue) => {
    const state = issue.state?.name ?? "state unknown";
    return `- ${issue.identifier} / ${issue.title} / ${state}`;
  }).join("\n");
}

function formatWebSummary(
  searchResults: Awaited<ReturnType<typeof webSearchFetch>>,
  fetchedPages: Awaited<ReturnType<typeof webFetchUrl>>[],
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

function extractResearchNextActionsFromTexts(
  texts: string[],
  existingTitles: string[],
  policy: ManagerPolicy,
): string[] {
  const existingNormalizedTitles = new Set(existingTitles.map((title) => normalizeText(title)));
  const candidates = unique(texts.flatMap((text) => {
    const segments = extractTaskSegments(text);
    const sourceSegments = segments.length > 0
      ? segments
      : text
        .split(/[。\n]/)
        .map((segment) => segment.trim())
        .filter(Boolean);

    return sourceSegments
      .map((segment) => deriveIssueTitle(segment))
      .map((segment) => trimJapaneseParticles(segment))
      .filter((segment) => segment.length >= 6)
      .filter((segment) => ACTIONABLE_RESEARCH_PATTERN.test(segment));
  }));

  return candidates
    .filter((candidate) => {
      const normalizedCandidate = normalizeText(candidate);
      if (!normalizedCandidate) return false;
      for (const existing of existingNormalizedTitles) {
        if (existing.includes(normalizedCandidate) || normalizedCandidate.includes(existing)) {
          return false;
        }
      }
      return true;
    })
    .slice(0, policy.researchAutoPlanMaxChildren);
}

function formatResearchNextActions(nextActions: string[]): string {
  if (nextActions.length === 0) {
    return "- 調査結果をもとに必要な実行子 issue を追加する。";
  }
  return nextActions.map((action) => `- ${action}`).join("\n");
}

function buildResearchComment(args: {
  sourceMessage: ManagerSlackMessage;
  slackThreadEntries: Awaited<ReturnType<typeof getSlackThreadContext>>["entries"];
  recentChannelContexts: Awaited<ReturnType<typeof getRecentChannelContext>>;
  relatedIssues: LinearIssue[];
  searchResults: Awaited<ReturnType<typeof webSearchFetch>>;
  fetchedPages: Awaited<ReturnType<typeof webFetchUrl>>[];
  nextActions: string[];
}): string {
  const recentContextSummary = args.recentChannelContexts.length > 0
    ? args.recentChannelContexts
      .slice(0, 3)
      .map((context) => `- ${context.rootThreadTs}: ${context.entries.slice(-1)[0]?.text.replace(/\s+/g, " ").slice(0, 120) ?? "(no messages)"}`)
      .join("\n")
    : "- 直近 thread 文脈は取得できませんでした。";

  return [
    "## Slack source",
    `- channelId: ${args.sourceMessage.channelId}`,
    `- rootThreadTs: ${args.sourceMessage.rootThreadTs}`,
    `- sourceMessageTs: ${args.sourceMessage.messageTs}`,
    "",
    "## 調べた範囲",
    "- Slack thread context",
    "- Slack recent channel context",
    "- Linear related issues / comments / relations",
    "- Lightweight web search",
    "",
    "## 分かったこと",
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
    "",
    "## 未確定事項",
    "- スコープ・期限・実行順の確定が必要なら control room で確認する。",
    "",
    "## 次アクション",
    formatResearchNextActions(args.nextActions),
  ].join("\n");
}

function formatIssueLine(issue: LinearIssue): string {
  const parts = [issue.identifier, issue.title];
  if (issue.assignee?.displayName || issue.assignee?.name) {
    parts.push(`担当: ${issue.assignee.displayName ?? issue.assignee.name}`);
  }
  if (issue.dueDate) {
    parts.push(`期限: ${issue.dueDate}`);
  }
  return `- ${parts.join(" / ")}`;
}

function formatIssueReference(issue: Pick<LinearIssue, "identifier" | "title">): string {
  return `${issue.identifier} ${issue.title}`;
}

function formatAutonomousCreateReply(
  parent: LinearIssue | undefined,
  children: LinearIssue[],
  reason: string,
  usedFallback: boolean,
  options?: { reusedParent?: boolean },
): string {
  const primary = parent ?? children[0];
  const lines = ["Linear に登録しました。"];

  if (reason === "research-first" && parent && children[0]) {
    if (options?.reusedParent) {
      lines.push(`既存の親 issue ${formatIssueReference(parent)} 配下に、調査 task ${formatIssueReference(children[0])} を追加しました。`);
    } else {
      lines.push(`親 issue ${formatIssueReference(parent)} と、調査 task ${formatIssueReference(children[0])} を作成しました。`);
    }
  } else if (parent && children.length > 0) {
    lines.push(`親 issue は ${formatIssueReference(parent)} です。`);
    lines.push("今回の実行 task:");
    for (const child of children) {
      lines.push(formatIssueLine(child));
    }
  } else if (children.length === 1) {
    lines.push(`今回の task は ${formatIssueReference(children[0])} です。`);
  } else if (children.length > 1) {
    lines.push("実行 task:");
    for (const child of children) {
      lines.push(formatIssueLine(child));
    }
  }

  if (usedFallback) {
    lines.push("担当が未定義だったため、暫定で kyaukyuai に寄せています。");
  }

  lines.push("この thread で進捗・完了・blocked をそのまま返してください。");
  if (primary?.url) {
    lines.push(`URL: ${primary.url}`);
  }

  return lines.join("\n");
}

function formatExistingIssueReply(duplicates: LinearIssue[]): string {
  const lines = ["既存の Linear issue が見つかったため、新規起票は行いませんでした。"];
  if (duplicates.length === 1) {
    lines.push(`この thread では ${formatIssueReference(duplicates[0])} を扱います。`);
    lines.push("進捗・完了・blocked はこのまま thread に返してください。");
    if (duplicates[0]?.url) {
      lines.push(`URL: ${duplicates[0].url}`);
    }
    return lines.join("\n");
  }

  lines.push("候補が複数あるため、必要なら対象 issue を明示してください。");
  for (const issue of duplicates.slice(0, 3)) {
    lines.push(`- ${formatIssueReference(issue)}`);
  }
  return lines.join("\n");
}

function formatStatusReply(
  kind: Exclude<ManagerMessageKind, "conversation" | "request">,
  issues: LinearIssue[],
  extras: string[] = [],
): string {
  const references = issues.map((issue) => formatIssueReference(issue)).join(" / ");
  const lines =
    kind === "completed"
      ? [
          "完了を Linear に反映しました。",
          `対象: ${references}`,
          "残っている作業や次に進めることがあれば、この thread で続けてください。",
        ]
      : kind === "blocked"
        ? [
            "blocked 状態を Linear に反映しました。",
            `対象: ${references}`,
            "誰の返答待ちか、何がそろえば再開できるかが分かったら、この thread で追記してください。",
          ]
        : [
            "進捗を Linear に反映しました。",
            `対象: ${references}`,
            "次に進めることや追加で詰まっている点があれば、この thread で続けてください。",
          ];

  return [...lines, ...extras].join("\n");
}

function buildResearchSlackSummary(args: {
  parent: LinearIssue;
  researchChild: LinearIssue;
  reusedParent: boolean;
  relatedIssues: LinearIssue[];
  searchResults: Awaited<ReturnType<typeof webSearchFetch>>;
  followupChildren?: LinearIssue[];
  nextActions: string[];
}): string {
  const lines = ["調査内容を Linear に記録しました。"];

  if (args.reusedParent) {
    lines.push(`既存の親 issue ${formatIssueReference(args.parent)} 配下に、調査 task ${formatIssueReference(args.researchChild)} を追加しています。`);
  } else {
    lines.push(`親 issue は ${formatIssueReference(args.parent)}、調査 task は ${formatIssueReference(args.researchChild)} です。`);
  }

  lines.push("調べた範囲: Slack thread / 関連 Linear issue / Web");
  if (args.relatedIssues.length > 0) {
    lines.push(`分かったこと: 関連 issue として ${formatIssueReference(args.relatedIssues[0])} を確認しました。`);
  } else if (args.searchResults.length > 0) {
    lines.push(`分かったこと: Web では ${args.searchResults[0]?.title ?? "関連情報"} を確認しました。`);
  } else {
    lines.push("分かったこと: まず関連情報の洗い出しを開始しました。");
  }
  lines.push("未確定事項: スコープや対処方針の確定が必要なら、この thread で詰めます。");
  if ((args.followupChildren?.length ?? 0) > 0) {
    lines.push(`次アクション: 調査結果をもとに追加 task を ${args.followupChildren!.length} 件作成しました。`);
    for (const child of args.followupChildren ?? []) {
      lines.push(formatIssueLine(child));
    }
  } else if (args.nextActions.length > 0) {
    lines.push(`次アクション: ${args.nextActions[0]}`);
  } else {
    lines.push("次アクション: 調査結果をもとに必要なら実行 task を追加します。");
  }
  if (args.parent.url) {
    lines.push(`URL: ${args.parent.url}`);
  }
  return lines.join("\n");
}

function getPrimaryRiskCategory(item: RiskAssessment): string {
  const rank: Record<string, number> = {
    overdue: 0,
    due_today: 1,
    blocked: 2,
    stale: 3,
    due_soon: 4,
    owner_missing: 5,
    due_missing: 6,
  };

  return [...item.riskCategories].sort((left, right) => (rank[left] ?? 99) - (rank[right] ?? 99))[0] ?? "review";
}

function formatReviewFollowupPrompt(item: RiskAssessment): string {
  const primaryCategory = getPrimaryRiskCategory(item);
  if (primaryCategory === "blocked") {
    return `確認したいこと: ${item.issue.identifier} は何待ちですか。再開条件を control room で共有してください。`;
  }
  if (primaryCategory === "overdue" || primaryCategory === "due_today" || primaryCategory === "due_soon") {
    return `確認したいこと: ${item.issue.identifier} の次の一手と完了見込みを control room で共有してください。`;
  }
  if (primaryCategory === "owner_missing") {
    return `確認したいこと: ${item.issue.identifier} の担当を決めて control room で共有してください。`;
  }
  if (primaryCategory === "due_missing") {
    return `確認したいこと: ${item.issue.identifier} の期限が必要なら control room で共有してください。`;
  }
  return `確認したいこと: ${item.issue.identifier} の最新状況と次に進める作業を control room で共有してください。`;
}

function selectReviewFollowupItem(
  items: RiskAssessment[],
  followups: FollowupLedgerEntry[],
  policy: ManagerPolicy,
  now: Date,
): RiskAssessment | undefined {
  if (policy.reviewExplicitFollowupCount <= 0) {
    return undefined;
  }

  return items.find((item) => !shouldSuppressFollowup(
    followups,
    item.issue.identifier,
    getPrimaryRiskCategory(item),
    policy.followupCooldownHours,
    now,
  ));
}

function getJstDayString(date: Date): string {
  return toJstDate(date).toISOString().slice(0, 10);
}

export function businessDaysSince(updatedAt: string | undefined, now = new Date()): number {
  if (!updatedAt) return Number.MAX_SAFE_INTEGER;
  const start = toJstDate(new Date(updatedAt));
  const end = toJstDate(now);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const target = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  let businessDays = 0;

  while (cursor.getTime() < target.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      businessDays += 1;
    }
  }

  return businessDays;
}

export function assessRisk(issue: LinearIssue, policy: ManagerPolicy, now = new Date()): RiskAssessment {
  const today = getJstDayString(now);
  const tomorrow = getJstDayString(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const dueDate = issue.dueDate ?? undefined;
  const ownerMissing = !issue.assignee;
  const dueMissing = !dueDate;
  const blockedState =
    issue.state?.name?.toLowerCase().includes("block") === true ||
    issue.state?.type?.toLowerCase().includes("block") === true;
  const blockedByRelation = (issue.relations ?? []).some((relation) => normalizeRelationType(relation.type).includes("blockedby"));
  const inverseBlockingRelation = (issue.inverseRelations ?? []).some((relation) => {
    const normalized = normalizeRelationType(relation.type);
    return normalized.includes("blocks") || normalized.includes("blockedby");
  });
  const blocked = blockedState || blockedByRelation || inverseBlockingRelation;
  const staleDays = businessDaysSince(issue.updatedAt ?? undefined, now);
  const riskCategories: string[] = [];

  if (dueDate) {
    if (dueDate < today) {
      riskCategories.push("overdue");
    } else if (dueDate === today) {
      riskCategories.push("due_today");
    } else if (dueDate === tomorrow) {
      riskCategories.push("due_soon");
    }
  }

  if (staleDays >= policy.staleBusinessDays) {
    riskCategories.push("stale");
  }
  if (blocked) {
    riskCategories.push("blocked");
  }
  if (ownerMissing) {
    riskCategories.push("owner_missing");
  }
  if (dueMissing) {
    riskCategories.push("due_missing");
  }

  return {
    issue,
    riskCategories: unique(riskCategories),
    ownerMissing,
    dueMissing,
    blocked,
    businessDaysSinceUpdate: staleDays,
  };
}

function sortRiskyIssues(items: RiskAssessment[]): RiskAssessment[] {
  const rank: Record<string, number> = {
    overdue: 0,
    due_today: 1,
    blocked: 2,
    stale: 3,
    due_soon: 4,
    owner_missing: 5,
    due_missing: 6,
  };

  return [...items].sort((left, right) => {
    const leftRank = Math.min(...left.riskCategories.map((category) => rank[category] ?? 99));
    const rightRank = Math.min(...right.riskCategories.map((category) => rank[category] ?? 99));
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (right.issue.priority ?? 0) - (left.issue.priority ?? 0);
  });
}

function isWithinBusinessHours(policy: ManagerPolicy, now = new Date()): boolean {
  const jst = toJstDate(now);
  const weekday = jst.getUTCDay();
  const isoWeekday = weekday === 0 ? 7 : weekday;
  if (!policy.businessHours.weekdays.includes(isoWeekday)) return false;

  const current = `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
  return current >= policy.businessHours.start && current <= policy.businessHours.end;
}

function isUrgentRisk(item: RiskAssessment, policy: ManagerPolicy): boolean {
  if (item.riskCategories.includes("overdue") || item.riskCategories.includes("due_today")) {
    return true;
  }
  if (item.riskCategories.includes("blocked")) {
    return true;
  }
  if (item.riskCategories.includes("stale") && (item.issue.priority ?? 0) > 0 && (item.issue.priority ?? 99) <= policy.urgentPriorityThreshold) {
    return true;
  }
  return false;
}

function shouldSuppressFollowup(
  followups: FollowupLedgerEntry[],
  issueId: string,
  category: string,
  cooldownHours: number,
  now = new Date(),
): boolean {
  const existing = followups.find((entry) => entry.issueId === issueId && entry.lastCategory === category);
  if (!existing?.lastPublicFollowupAt) return false;
  const elapsedMs = now.getTime() - Date.parse(existing.lastPublicFollowupAt);
  return elapsedMs < cooldownHours * 60 * 60 * 1000;
}

export async function handleManagerMessage(
  config: AppConfig,
  systemPaths: SystemPaths,
  message: ManagerSlackMessage,
  now = new Date(),
): Promise<ManagerHandleResult> {
  const policy = await loadManagerPolicy(systemPaths);
  const intakeLedger = await loadIntakeLedger(systemPaths);
  const pendingClarification = findPendingClarification(intakeLedger, message);
  const originalRequestText = pendingClarification?.originalText ?? message.text;
  const followupText = pendingClarification ? message.text : "";
  const combinedRequestText = pendingClarification
    ? `${originalRequestText}\n${followupText}`.trim()
    : message.text;
  const requestMessage: ManagerSlackMessage = pendingClarification
    ? {
        ...message,
        messageTs: pendingClarification.sourceMessageTs,
        text: combinedRequestText,
      }
    : message;
  const signal = pendingClarification ? "request" : classifyManagerSignal(message.text);
  if (signal !== "request" && signal !== "conversation") {
    const env = {
      ...process.env,
      LINEAR_API_KEY: config.linearApiKey,
      LINEAR_WORKSPACE: config.linearWorkspace,
      LINEAR_TEAM_KEY: config.linearTeamKey,
    };
    if (!policy.autoStatusUpdate) {
      return { handled: false };
    }
    const resolution = await resolveIssueTargetsFromThread(intakeLedger, message, env);
    if (resolution.reason === "missing" || resolution.reason === "ambiguous") {
      return {
        handled: true,
        reply: formatIssueSelectionReply(signal, resolution.issueIds),
      };
    }

    const targetIssueIds = resolution.issueIds;
    const extras: string[] = [];
    const updatedIssues: LinearIssue[] = [];

    if (signal === "progress") {
      for (const issueId of targetIssueIds) {
        await addLinearProgressComment(issueId, formatStatusSourceComment(message, "## Progress source"), env);
        updatedIssues.push(await getLinearIssue(issueId, env));
      }
    } else if (signal === "completed") {
      for (const issueId of targetIssueIds) {
        updatedIssues.push(await updateLinearIssueState(issueId, "completed", env));
        await addLinearComment(issueId, formatStatusSourceComment(message, "## Completion source"), env);
      }
    } else if (signal === "blocked") {
      for (const issueId of targetIssueIds) {
        const result = await markLinearIssueBlocked(issueId, formatStatusSourceComment(message, "## Blocked source"), env);
        updatedIssues.push(result.issue);
        if (!result.blockedStateApplied) {
          extras.push(`${issueId} は workflow に blocked state が無いため、comment のみ追加しました。`);
        }
      }
    }

    const nextLedger = upsertThreadIntakeEntry(
      intakeLedger,
      message,
      {
        status: signal === "progress" ? "progressed" : signal,
        lastResolvedIssueId: targetIssueIds[0],
      },
      now,
    );
    await saveIntakeLedger(systemPaths, nextLedger);

    return {
      handled: true,
      reply: formatStatusReply(signal, updatedIssues, extras),
    };
  }

  if (signal !== "request") {
    return { handled: false };
  }

  if (!policy.autoCreate) {
    return { handled: false };
  }

  const ownerMap = await loadOwnerMap(systemPaths);
  const planningLedger = await loadPlanningLedger(systemPaths);
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  const fingerprint = pendingClarification?.messageFingerprint ?? fingerprintText(requestMessage.text);
  const existingLedgerEntry = intakeLedger.find((entry) => {
    if (entry.status === "needs-clarification") return false;
    return buildIntakeKey(entry) === buildIntakeKey({
      sourceChannelId: requestMessage.channelId,
      sourceThreadTs: requestMessage.rootThreadTs,
      messageFingerprint: fingerprint,
    });
  });

  if (existingLedgerEntry) {
    const linkedIssues = unique([existingLedgerEntry.parentIssueId, ...existingLedgerEntry.childIssueIds].filter(Boolean)) as string[];
    return {
      handled: true,
      reply: linkedIssues.length > 0
        ? ["この依頼は既に取り込まれています。", ...linkedIssues.map((issueId) => `- ${issueId}`)].join("\n")
        : "この依頼は既に取り込まれています。",
    };
  }

  const clarificationNeeds = detectClarificationNeeds(requestMessage.text, now);
  const primaryTitle = deriveIssueTitle(originalRequestText);
  if (clarificationNeeds.length > 0) {
    const clarificationEntry: IntakeLedgerEntry = {
      sourceChannelId: requestMessage.channelId,
      sourceThreadTs: requestMessage.rootThreadTs,
      sourceMessageTs: pendingClarification?.sourceMessageTs ?? requestMessage.messageTs,
      messageFingerprint: fingerprint,
      childIssueIds: [],
      status: "needs-clarification",
      originalText: requestMessage.text,
      clarificationQuestion: formatClarificationReply(primaryTitle, clarificationNeeds),
      clarificationReasons: clarificationNeeds,
      createdAt: pendingClarification?.createdAt ?? nowIso(now),
      updatedAt: nowIso(now),
    };
    const nextLedger = [
      ...intakeLedger.filter((entry) => entry !== pendingClarification),
      clarificationEntry,
    ];
    await saveIntakeLedger(systemPaths, nextLedger);
    return {
      handled: true,
      reply: clarificationEntry.clarificationQuestion,
    };
  }

  const dueDate = extractDueDate(requestMessage.text, now);
  const segmentsFromFollowup = pendingClarification ? extractTaskSegments(followupText) : [];
  const segments = segmentsFromFollowup.length > 0 ? segmentsFromFollowup : extractTaskSegments(requestMessage.text);
  const complex = isComplexRequest(originalRequestText) || segments.length >= 2;
  const research = needsResearchTask(originalRequestText);
  const planningTitle = derivePlanningTitle(originalRequestText, research, segments);
  const globalDueDate = segments.length >= 2 ? extractGlobalDueDate(requestMessage.text, now) : dueDate;
  const duplicates = await searchLinearIssues(
    {
      query: planningTitle.slice(0, 32),
      limit: 5,
    },
    env,
  );

  if (duplicates.length > 0 && !research) {
    const nextLedger = [
      ...intakeLedger.filter((entry) => entry !== pendingClarification),
      {
        sourceChannelId: requestMessage.channelId,
        sourceThreadTs: requestMessage.rootThreadTs,
        sourceMessageTs: pendingClarification?.sourceMessageTs ?? requestMessage.messageTs,
        messageFingerprint: fingerprint,
        childIssueIds: duplicates.map((issue) => issue.identifier),
        status: "linked-existing",
        lastResolvedIssueId: duplicates.length === 1 ? duplicates[0]?.identifier : undefined,
        originalText: requestMessage.text,
        clarificationReasons: [],
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
      },
    ];
    await saveIntakeLedger(systemPaths, nextLedger);
    return {
      handled: true,
      reply: formatExistingIssueReply(duplicates),
    };
  }

  const planningReason = research ? "research-first" : complex ? "complex-request" : "single-issue";
  const rawChildren = research
    ? unique([`調査: ${planningTitle}`, ...segments])
    : segments.length > 0
      ? segments
      : complex
        ? [`実行: ${primaryTitle}`]
        : [primaryTitle];
  const existingResearchParent = research ? chooseExistingResearchParent(duplicates, planningTitle) : undefined;
  const needsNewParent = (complex || research) && !existingResearchParent;
  const usedFallbackOwners = new Set<string>();
  const parentOwner = needsNewParent ? chooseOwner(planningTitle, ownerMap) : undefined;
  if (parentOwner?.resolution === "fallback") {
    usedFallbackOwners.add(parentOwner.entry.id);
  }

  const plannedChildren = rawChildren.map((childText) => {
    const parsedChild = parseTaskSegment(childText, now);
    const owner = chooseOwner(parsedChild.title, ownerMap);
    if (!parsedChild.assignee && owner.resolution === "fallback") {
      usedFallbackOwners.add(owner.entry.id);
    }

    return {
      childText,
      title: parsedChild.title,
      description: research && childText.startsWith("調査:")
        ? [
            "## Slack source",
            requestMessage.text,
            "",
            "## 調べた範囲",
            "- ここに調査対象を書く",
            "",
            "## 分かったこと",
            "- ここに調査結果を書く",
            "",
            "## 未確定事項",
            "- ここに未確定事項を書く",
            "",
            "## 次アクション",
            "- ここに次アクションを書く",
          ].join("\n")
        : [
            "## Slack source",
            requestMessage.text,
            "",
            "## 完了条件",
            "- 実行単位で完了できる状態にする",
          ].join("\n"),
      dueDate: parsedChild.dueDate ?? globalDueDate,
      assignee: parsedChild.assignee ?? owner.entry.linearAssignee,
      priority: (parsedChild.dueDate ?? globalDueDate) ? 2 : undefined,
      isResearch: research && childText.startsWith("調査:"),
    };
  });

  let createdParent: LinearIssue | undefined;
  let parent = existingResearchParent;
  let createdChildren: LinearIssue[] = [];
  let researchChild: LinearIssue | undefined;

  if (needsNewParent && plannedChildren.length >= 2) {
    const batch = await createManagedLinearIssueBatch(
      {
        parent: {
          title: planningTitle,
          description: [
            "## 目的",
            planningTitle,
            "",
            "## 完了条件",
            "- Slack の依頼を親 issue として管理する",
            "- 実行子 issue で前進できる状態にする",
          ].join("\n"),
          assignee: parentOwner?.entry.linearAssignee,
          dueDate: globalDueDate,
          priority: globalDueDate ? 2 : undefined,
        },
        children: plannedChildren.map((child) => ({
          title: child.title,
          description: child.description,
          dueDate: child.dueDate,
          assignee: child.assignee,
          priority: child.priority,
        })),
      },
      env,
    );
    createdParent = batch.parent;
    parent = batch.parent;
    createdChildren = batch.children;
    researchChild = createdChildren.find((child) => child.title.startsWith("調査:"));
  } else {
    createdParent = needsNewParent
      ? await createManagedLinearIssue(
          {
            title: planningTitle,
            description: [
              "## 目的",
              planningTitle,
              "",
              "## 完了条件",
              "- Slack の依頼を親 issue として管理する",
              "- 実行子 issue で前進できる状態にする",
            ].join("\n"),
            assignee: parentOwner?.entry.linearAssignee,
            dueDate: globalDueDate,
            priority: globalDueDate ? 2 : undefined,
          },
          env,
        )
      : undefined;
    parent = existingResearchParent ?? createdParent;

    for (const child of plannedChildren) {
      const createdChild = await createManagedLinearIssue(
        {
          title: child.title,
          description: child.description,
          dueDate: child.dueDate,
          parent: parent?.identifier,
          assignee: child.assignee,
          priority: child.priority,
        },
        env,
      );

      createdChildren.push(createdChild);
      if (child.isResearch) {
        researchChild = createdChild;
      }
    }
  }

  for (const child of createdChildren) {
    await addLinearComment(child.identifier, formatSourceComment(requestMessage, planningReason), env);
  }

  if (parent) {
    await addLinearComment(parent.identifier, formatSourceComment(requestMessage, planningReason), env);
  }

  if (parent && createdChildren.length > 1) {
    for (let index = 1; index < createdChildren.length; index += 1) {
      await addLinearRelation(createdChildren[index - 1].identifier, "blocks", createdChildren[index].identifier, env);
    }
  }

  if (researchChild) {
    const slackThreadContext = await getSlackThreadContext(config.workspaceDir, requestMessage.channelId, requestMessage.rootThreadTs).catch(() => ({
      channelId: requestMessage.channelId,
      rootThreadTs: requestMessage.rootThreadTs,
      entries: [],
    }));
    const recentChannelContexts = await getRecentChannelContext(config.workspaceDir, requestMessage.channelId, 3, 6).catch(() => []);
    const relatedIssues = (await searchLinearIssues(
      {
        query: primaryTitle.slice(0, 32),
        limit: 5,
      },
      env,
    ).catch(() => [])).filter((issue) => issue.identifier !== researchChild?.identifier && issue.identifier !== parent?.identifier);
    const searchResults = await webSearchFetch(primaryTitle, 3).catch(() => []);
    const fetchedPages: Awaited<ReturnType<typeof webFetchUrl>>[] = [];
    for (const result of searchResults.slice(0, 2)) {
      try {
        fetchedPages.push(await webFetchUrl(result.url));
      } catch {
        // Ignore fetch failures for individual pages and keep the rest of the research summary.
      }
    }

    const researchNextActions = extractResearchNextActionsFromTexts(
      [
        requestMessage.text,
        ...slackThreadContext.entries.map((entry) => entry.text),
      ],
      [parent?.title, ...createdChildren.map((issue) => issue.title)].filter(Boolean) as string[],
      policy,
    );

    await addLinearComment(
      researchChild.identifier,
      buildResearchComment({
        sourceMessage: requestMessage,
        slackThreadEntries: slackThreadContext.entries,
        recentChannelContexts,
        relatedIssues,
        searchResults,
        fetchedPages,
        nextActions: researchNextActions,
      }),
      env,
    );

    const followupChildren: LinearIssue[] = [];
    if (policy.autoPlan && researchNextActions.length >= policy.researchAutoPlanMinActions) {
      const parentAssignee = parent?.assignee?.displayName ?? parent?.assignee?.name;
      for (const nextAction of researchNextActions) {
        const owner = chooseOwner(nextAction, ownerMap);
        if (owner.resolution === "fallback") {
          usedFallbackOwners.add(owner.entry.id);
        }

        const followupChild = await createManagedLinearIssue(
          {
            title: nextAction,
            description: [
              "## Research source",
              formatIssueReference(researchChild),
              "",
              "## Slack source",
              requestMessage.text,
              "",
              "## 完了条件",
              "- 調査結果を踏まえて実行可能な状態にする",
            ].join("\n"),
            parent: parent?.identifier,
            assignee: owner.resolution === "mapped" ? owner.entry.linearAssignee : parentAssignee ?? owner.entry.linearAssignee,
            dueDate: researchChild.dueDate ?? parent?.dueDate ?? undefined,
            priority: (researchChild.dueDate ?? parent?.dueDate) ? 2 : undefined,
          },
          env,
        );
        followupChildren.push(followupChild);
      }
    }

    const allCreatedChildren = [...createdChildren, ...followupChildren];

    const nextIntakeEntry: IntakeLedgerEntry = {
      sourceChannelId: requestMessage.channelId,
      sourceThreadTs: requestMessage.rootThreadTs,
      sourceMessageTs: pendingClarification?.sourceMessageTs ?? requestMessage.messageTs,
      messageFingerprint: fingerprint,
      parentIssueId: parent?.identifier,
      childIssueIds: allCreatedChildren.map((issue) => issue.identifier),
      status: "created",
      ownerResolution: usedFallbackOwners.size > 0 ? "fallback" : "mapped",
      originalText: requestMessage.text,
      clarificationReasons: [],
      lastResolvedIssueId: researchChild.identifier,
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    };
    await saveIntakeLedger(systemPaths, [
      ...intakeLedger.filter((entry) => entry !== pendingClarification),
      nextIntakeEntry,
    ]);

    const planningEntry: PlanningLedgerEntry = {
      sourceThread: `${message.channelId}:${message.rootThreadTs}`,
      parentIssueId: parent?.identifier,
      generatedChildIssueIds: allCreatedChildren.map((issue) => issue.identifier),
      planningReason,
      ownerResolution: usedFallbackOwners.size > 0 ? "fallback" : "mapped",
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    };
    await savePlanningLedger(systemPaths, [...planningLedger, planningEntry]);

    return {
      handled: true,
      reply: buildResearchSlackSummary({
        parent: parent!,
        researchChild,
        reusedParent: Boolean(existingResearchParent),
        relatedIssues,
        searchResults,
        followupChildren,
        nextActions: researchNextActions,
      }),
    };
  }

  const ownerResolution = usedFallbackOwners.size > 0 ? "fallback" : "mapped";
  const nextIntakeEntry: IntakeLedgerEntry = {
    sourceChannelId: requestMessage.channelId,
    sourceThreadTs: requestMessage.rootThreadTs,
    sourceMessageTs: pendingClarification?.sourceMessageTs ?? requestMessage.messageTs,
    messageFingerprint: fingerprint,
    parentIssueId: parent?.identifier,
    childIssueIds: createdChildren.map((issue) => issue.identifier),
    status: "created",
    ownerResolution,
    originalText: requestMessage.text,
    clarificationReasons: [],
    lastResolvedIssueId: createdChildren.length === 1 ? createdChildren[0]?.identifier : createdChildren.length === 0 ? parent?.identifier : undefined,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  };
  await saveIntakeLedger(systemPaths, [
    ...intakeLedger.filter((entry) => entry !== pendingClarification),
    nextIntakeEntry,
  ]);

  const planningEntry: PlanningLedgerEntry = {
    sourceThread: `${message.channelId}:${message.rootThreadTs}`,
    parentIssueId: parent?.identifier,
    generatedChildIssueIds: createdChildren.map((issue) => issue.identifier),
    planningReason,
    ownerResolution,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  };
  await savePlanningLedger(systemPaths, [...planningLedger, planningEntry]);

  return {
    handled: true,
    reply: formatAutonomousCreateReply(parent, createdChildren, planningReason, usedFallbackOwners.size > 0, {
      reusedParent: Boolean(existingResearchParent),
    }),
  };
}

function formatRiskLine(item: RiskAssessment): string {
  const categories = item.riskCategories.join(", ");
  const assignee = item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? "未割当";
  const due = item.issue.dueDate ?? "期限未設定";
  return `- ${item.issue.identifier} / ${item.issue.title} / ${categories} / 担当: ${assignee} / 期限: ${due}`;
}

export async function buildManagerReview(
  config: AppConfig,
  systemPaths: SystemPaths,
  kind: ManagerReviewKind,
  now = new Date(),
): Promise<string | undefined> {
  const policy = await loadManagerPolicy(systemPaths);
  const followups = await loadFollowupsLedger(systemPaths);
  const planningLedger = await loadPlanningLedger(systemPaths);
  const intakeLedger = await loadIntakeLedger(systemPaths);
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  const risky = (await listRiskyLinearIssues(
    {
      staleBusinessDays: policy.staleBusinessDays,
      urgentPriorityThreshold: policy.urgentPriorityThreshold,
    },
    env,
  )).map((issue) => assessRisk(issue, policy, now)).filter((item) => item.riskCategories.length > 0);

  if (kind === "heartbeat") {
    if (!isWithinBusinessHours(policy, now)) {
      return undefined;
    }

    const urgent = sortRiskyIssues(risky).filter((item) => isUrgentRisk(item, policy)).filter((item) => {
      const category = item.riskCategories[0] ?? "heartbeat";
      return !shouldSuppressFollowup(followups, item.issue.identifier, category, policy.followupCooldownHours, now);
    });

    if (urgent.length === 0) {
      return undefined;
    }

    const top = urgent[0];
    const category = top.riskCategories[0] ?? "heartbeat";
    const nextFollowups = upsertFollowup(followups, {
      issueId: top.issue.identifier,
      lastPublicFollowupAt: nowIso(now),
      lastCategory: category,
    });
    await saveFollowupsLedger(systemPaths, nextFollowups);

    return [
      "緊急フォローが必要です。",
      formatRiskLine(top),
      "必要な返答を control room で確認してください。",
    ].join("\n");
  }

  const sorted = sortRiskyIssues(risky);
  if (kind === "morning-review") {
    const lines = ["朝の execution review です。"];
    const items = sorted.filter((item) => !item.riskCategories.includes("due_missing")).slice(0, 5);
    if (items.length === 0) {
      return "朝の execution review です。\n- 今日すぐに共有すべきリスクはありません。";
    }
    lines.push("今日やるべきこと / 期限リスク / stale:");
    for (const item of items) lines.push(formatRiskLine(item));
    const followupItem = selectReviewFollowupItem(items, followups, policy, now);
    if (followupItem) {
      await saveFollowupsLedger(systemPaths, upsertFollowup(followups, {
        issueId: followupItem.issue.identifier,
        lastPublicFollowupAt: nowIso(now),
        lastCategory: getPrimaryRiskCategory(followupItem),
      }));
      lines.push(formatReviewFollowupPrompt(followupItem));
    }
    return lines.join("\n");
  }

  if (kind === "evening-review") {
    const lines = ["夕方の進捗 review です。"];
    const items = sorted
      .filter((item) => item.riskCategories.some((category) => ["due_today", "blocked", "overdue", "stale"].includes(category)))
      .slice(0, 5);
    if (items.length === 0) {
      return "夕方の進捗 review です。\n- 今日の残タスクで強いリスクは見当たりません。";
    }
    lines.push("今日残っていること / blocked / due today:");
    for (const item of items) lines.push(formatRiskLine(item));
    const followupItem = selectReviewFollowupItem(items, followups, policy, now);
    if (followupItem) {
      await saveFollowupsLedger(systemPaths, upsertFollowup(followups, {
        issueId: followupItem.issue.identifier,
        lastPublicFollowupAt: nowIso(now),
        lastCategory: getPrimaryRiskCategory(followupItem),
      }));
      lines.push(formatReviewFollowupPrompt(followupItem));
    }
    return lines.join("\n");
  }

  const fallbackCount = planningLedger.filter((entry) => entry.ownerResolution === "fallback").length;
  const unresolvedClarifications = intakeLedger.filter((entry) => entry.status === "needs-clarification").length;
  const staleItems = sorted.filter((item) => item.riskCategories.includes("stale")).slice(0, 5);
  const lines = ["週次 planning review です。"];
  lines.push(`- 未整備 issue: ${sorted.filter((item) => item.ownerMissing || item.dueMissing).length}`);
  lines.push(`- 長期 stale: ${staleItems.length}`);
  lines.push(`- owner map gap: ${fallbackCount}`);
  lines.push(`- 未処理 clarification: ${unresolvedClarifications}`);
  for (const item of staleItems) {
    lines.push(formatRiskLine(item));
  }
  const followupItem = selectReviewFollowupItem(staleItems, followups, policy, now);
  if (followupItem) {
    await saveFollowupsLedger(systemPaths, upsertFollowup(followups, {
      issueId: followupItem.issue.identifier,
      lastPublicFollowupAt: nowIso(now),
      lastCategory: getPrimaryRiskCategory(followupItem),
    }));
    lines.push(formatReviewFollowupPrompt(followupItem));
  }
  return lines.join("\n");
}

function upsertFollowup(
  followups: FollowupLedgerEntry[],
  patch: FollowupLedgerEntry,
): FollowupLedgerEntry[] {
  const index = followups.findIndex((entry) => entry.issueId === patch.issueId);
  if (index === -1) {
    return [...followups, patch];
  }
  const next = [...followups];
  next[index] = {
    ...next[index],
    ...patch,
  };
  return next;
}
