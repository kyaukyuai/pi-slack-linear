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
  updateManagedLinearIssue,
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
import {
  runFollowupResolutionTurn,
  runResearchSynthesisTurn,
  type FollowupResolutionResult,
  type ResearchNextAction,
  type ResearchSynthesisResult,
} from "./pi-session.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import type { SystemPaths } from "./system-workspace.js";
import { buildThreadPaths } from "./thread-workspace.js";
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

export interface ManagerFollowupSource {
  channelId: string;
  rootThreadTs: string;
  sourceMessageTs: string;
}

export interface ManagerReviewFollowup {
  issueId: string;
  issueTitle: string;
  request: string;
  requestKind: "status" | "blocked-details" | "owner" | "due-date";
  acceptableAnswerHint?: string;
  assigneeDisplayName?: string;
  slackUserId?: string;
  riskCategory: string;
  shouldMention: boolean;
  source?: ManagerFollowupSource;
}

export interface ManagerReviewIssueLine {
  issueId: string;
  title: string;
  assigneeDisplayName?: string;
  riskSummary: string;
}

export interface ManagerReviewResult {
  kind: ManagerReviewKind;
  text: string;
  summaryLines?: string[];
  issueLines?: ManagerReviewIssueLine[];
  followup?: ManagerReviewFollowup;
}

export type HeartbeatNoopReason =
  | "outside-business-hours"
  | "no-active-channels"
  | "no-urgent-items"
  | "suppressed-by-cooldown";

export interface HeartbeatReviewDecision {
  review?: ManagerReviewResult;
  reason?: HeartbeatNoopReason;
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
const RESEARCH_TITLE_PATTERN = /(調査|検証|比較|リサーチ|洗い出し|調べ)/i;
const EXPLICIT_RESEARCH_REQUEST_PATTERN =
  /(?:を|について)?(調査|検証|比較|リサーチ|洗い出し|調べ)(しておいて|して|お願いします|お願い|したい|してほしい)?(?:[。!！?？\s]|$)/i;
const EXPLICIT_CONFIRM_REQUEST_PATTERN =
  /(?:を|について)?確認(しておいて|して|お願いします|お願い|したい|してほしい)(?:[。!！?？\s]|$)/i;
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
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const bulletLines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => LIST_MARKER_PATTERN.test(line))
    .map((line) => stripLeadingListMarker(line))
    .filter(Boolean);
  if (bulletLines.length >= 2) return false;
  if (extractInlineTaskSegments(text).length >= 2) return false;
  if (/(?:作業|対応|タスク)(?:は|を)?.+に分けて/i.test(normalized)) return false;
  return EXPLICIT_RESEARCH_REQUEST_PATTERN.test(normalized) || EXPLICIT_CONFIRM_REQUEST_PATTERN.test(normalized);
}

function isResearchIssueTitle(text: string): boolean {
  return RESEARCH_TITLE_PATTERN.test(text);
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
      const leftIsResearch = isResearchIssueTitle(left.title);
      const rightIsResearch = isResearchIssueTitle(right.title);
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

interface ResolvedIssueCandidate {
  issueId: string;
  title?: string;
  latestActionLabel?: string;
  focusReason?: string;
}

interface IssueTargetResolution {
  selectedIssueIds: string[];
  candidates: ResolvedIssueCandidate[];
  reason: "explicit" | "thread" | "missing" | "ambiguous";
}

function compactLinearIssues(issues: Array<LinearIssue | undefined>): LinearIssue[] {
  return issues.filter((issue): issue is LinearIssue => Boolean(issue));
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
    lastResolvedIssueId: latestEntry?.lastResolvedIssueId ?? threadEntries.find((entry) => entry.lastResolvedIssueId)?.lastResolvedIssueId,
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

function issueMatchesCompletedState(issue: LinearIssue): boolean {
  const stateName = issue.state?.name?.toLowerCase() ?? "";
  const stateType = issue.state?.type?.toLowerCase() ?? "";
  return ["done", "completed", "canceled", "cancelled"].some((token) => stateName.includes(token) || stateType.includes(token));
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
  message: Pick<ManagerSlackMessage, "channelId" | "rootThreadTs">,
): Promise<RecentFocusText[]> {
  const context = await getSlackThreadContext(workspaceDir, message.channelId, message.rootThreadTs, 12).catch(() => undefined);
  if (!context) return [];

  return context.entries
    .filter((entry): entry is (typeof context.entries)[number] & { type: "user" | "assistant" } => entry.type === "user" || entry.type === "assistant")
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
  kind: Exclude<ManagerMessageKind, "conversation" | "request">,
  recentFocusTexts: RecentFocusText[],
): ScoredIssueTarget {
  let score = 0;
  const normalizedIssueTitle = normalizeText(issue.title);
  const normalizedFocus = normalizeText(focusText);
  const focusTerms = extractSignalTerms(focusText);
  const titleSignalMatches = countLooseSignalOverlap(focusTerms, extractSignalTerms(issue.title));
  const commentSignalMatches = Math.max(
    0,
    ...getRecentLinearCommentBodies(issue).map((commentText) => countLooseSignalOverlap(focusTerms, extractSignalTerms(commentText))),
  );
  const recentSlackSignalMatches = Math.max(
    0,
    ...recentFocusTexts.map((recentFocus) => countLooseSignalOverlap(focusTerms, extractSignalTerms(recentFocus.text))),
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
    if (normalizedRecent.length >= 3 && (normalizedIssueTitle.includes(normalizedRecent) || normalizedRecent.includes(normalizedIssueTitle))) {
      score += recentFocus.type === "assistant" ? 8 : 14;
      continue;
    }
    score += Math.min(countTokenOverlap(issue.title, recentFocus.text) * weight, recentFocus.type === "assistant" ? 10 : 18);
  }

  for (const commentText of getRecentLinearCommentBodies(issue)) {
    const normalizedComment = normalizeText(commentText);
    if (normalizedComment.length >= 3 && (normalizedComment.includes(normalizedFocus) || normalizedFocus.includes(normalizedComment))) {
      score += 12;
      continue;
    }
    score += Math.min(countTokenOverlap(commentText, focusText) * 9, 18);
    for (const recentFocus of recentFocusTexts) {
      score += Math.min(countTokenOverlap(commentText, recentFocus.text) * (recentFocus.type === "assistant" ? 3 : 4), 8);
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
  if ((kind === "progress" || kind === "blocked" || kind === "completed") && candidates.childIssueIds.size > 0 && candidates.parentIssueIds.has(issue.identifier)) {
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

async function resolveIssueTargetsFromThread(
  intakeLedger: IntakeLedgerEntry[],
  message: Pick<ManagerSlackMessage, "channelId" | "rootThreadTs" | "text">,
  kind: Exclude<ManagerMessageKind, "conversation" | "request">,
  workspaceDir: string,
  env: Record<string, string | undefined>,
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
        return {
          ...scoreIssueTargetCandidate(issue, focusText, candidates, kind, recentFocusTexts),
        };
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
      latestActionLabel: formatLatestActionLabel(item.issue),
      focusReason: describeFocusReason(item.issue, candidates),
    })),
    reason: "ambiguous",
  };
}

export function formatIssueSelectionReply(
  kind: Exclude<ManagerMessageKind, "conversation" | "request">,
  issues: ResolvedIssueCandidate[],
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
      lines.push(`- ${issue.issueId}${issue.title ? ` / ${issue.title}` : ""}${issue.latestActionLabel ? ` / 最新: ${issue.latestActionLabel}` : ""}${issue.focusReason ? ` / 理由: ${issue.focusReason}` : ""}`);
    }
    lines.push("当てはまるものが無ければ `新規 task` と返してください。");
  } else {
    lines.push("同じ thread に紐づく issue が無かったため、`AIC-123` のように issue ID を含めてください。");
  }
  return lines.join("\n");
}

function findLatestIssueSource(
  intakeLedger: IntakeLedgerEntry[],
  issueId: string,
): ManagerFollowupSource | undefined {
  const entry = [...intakeLedger]
    .reverse()
    .find((candidate) => collectEntryIssueIds(candidate).includes(issueId));

  if (!entry) return undefined;

  return {
    channelId: entry.sourceChannelId,
    rootThreadTs: entry.sourceThreadTs,
    sourceMessageTs: entry.sourceMessageTs,
  };
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

function buildIssueFocusEvent(
  issueId: string,
  actionKind: string,
  source: string,
  textSnippet: string | undefined,
  now: Date,
): NonNullable<IntakeLedgerEntry["issueFocusHistory"]>[number] {
  return {
    issueId,
    actionKind,
    source,
    ts: nowIso(now),
    textSnippet: textSnippet?.replace(/\s+/g, " ").trim().slice(0, 140) || undefined,
  };
}

function appendIssueFocusHistory(
  existing: IntakeLedgerEntry["issueFocusHistory"] | undefined,
  nextEvents: NonNullable<IntakeLedgerEntry["issueFocusHistory"]>,
): NonNullable<IntakeLedgerEntry["issueFocusHistory"]> {
  return [...(existing ?? []), ...nextEvents].slice(-20);
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
    const issueFocusHistory = patch.issueFocusHistory
      ? appendIssueFocusHistory([], patch.issueFocusHistory)
      : [];
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
        issueFocusHistory,
      },
    ];
  }

  return intakeLedger.map((entry) => entry === latest
    ? {
        ...entry,
        ...patch,
        issueFocusHistory: patch.issueFocusHistory
          ? appendIssueFocusHistory(entry.issueFocusHistory, patch.issueFocusHistory)
          : entry.issueFocusHistory,
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

function extractTopLines(lines: string[], fallback: string): string {
  if (lines.length === 0) return `- ${fallback}`;
  return lines.map((line) => `- ${line}`).join("\n");
}

function buildFallbackResearchSynthesis(args: {
  slackThreadEntries: Awaited<ReturnType<typeof getSlackThreadContext>>["entries"];
  relatedIssues: LinearIssue[];
  searchResults: Awaited<ReturnType<typeof webSearchFetch>>;
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

function formatResearchNextActions(nextActions: ResearchNextAction[]): string {
  return extractTopLines(nextActions.map((action) => action.title), "調査結果をもとに必要な実行子 issue を追加する。");
}

function filterResearchNextActions(
  nextActions: ResearchNextAction[],
  existingTitles: string[],
  policy: ManagerPolicy,
): ResearchNextAction[] {
  const existingNormalizedTitles = new Set(existingTitles.map((title) => normalizeText(title)));
  const seen = new Set<string>();

  return nextActions
    .map((action) => ({
      ...action,
      title: trimJapaneseParticles(deriveIssueTitle(action.title)),
    }))
    .filter((action) => action.title.length >= 6)
    .filter((action) => action.confidence >= 0.6)
    .filter((action) => ACTIONABLE_RESEARCH_PATTERN.test(action.title))
    .filter((action) => {
      const normalizedCandidate = normalizeText(action.title);
      if (seen.has(normalizedCandidate)) return false;
      for (const existing of existingNormalizedTitles) {
        if (existing.includes(normalizedCandidate) || normalizedCandidate.includes(existing)) {
          return false;
        }
      }
      seen.add(normalizedCandidate);
      return true;
    })
    .slice(0, policy.researchAutoPlanMaxChildren);
}

function buildResearchIssueDescription(args: {
  sourceMessage: ManagerSlackMessage;
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
    extractTopLines(args.synthesis.uncertainties, "スコープ・期限・実行順の確定が必要なら control room で確認する。"),
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

function buildResearchComment(args: {
  sourceMessage: ManagerSlackMessage;
  slackThreadEntries: Awaited<ReturnType<typeof getSlackThreadContext>>["entries"];
  recentChannelContexts: Awaited<ReturnType<typeof getRecentChannelContext>>;
  relatedIssues: LinearIssue[];
  searchResults: Awaited<ReturnType<typeof webSearchFetch>>;
  fetchedPages: Awaited<ReturnType<typeof webFetchUrl>>[];
  synthesis: ResearchSynthesisResult;
}): string {
  const recentContextSummary = args.recentChannelContexts.length > 0
    ? args.recentChannelContexts
      .slice(0, 3)
      .map((context) => `- ${context.rootThreadTs}: ${context.entries.slice(-1)[0]?.text.replace(/\s+/g, " ").slice(0, 120) ?? "(no messages)"}`)
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

function truncateSlackText(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildSlackTargetLabel(issue: Pick<LinearIssue, "identifier" | "title">, maxLength = 80): string {
  return `${issue.identifier} ${truncateSlackText(issue.title, maxLength)}`;
}

function formatChildIssueSummaryForSlack(
  children: LinearIssue[],
  options?: { limit?: number; titleMaxLength?: number },
): string | undefined {
  if (children.length === 0) return undefined;
  const limit = options?.limit ?? 2;
  const titleMaxLength = options?.titleMaxLength ?? 80;
  const visible = children.slice(0, limit).map((issue) => buildSlackTargetLabel(issue, titleMaxLength));
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

  const urlLine = args.url ? `URL: ${args.url}` : undefined;
  const reservedForUrl = urlLine ? 1 : 0;
  const remaining = Math.max(0, maxLines - lines.length - reservedForUrl);
  lines.push(...bodyLines.slice(0, remaining));
  if (urlLine && lines.length < maxLines) {
    lines.push(urlLine);
  }

  return lines.join("\n");
}

export function formatIssueLineForSlack(issue: ManagerReviewIssueLine): string {
  const title = truncateSlackText(issue.title);
  const assignee = issue.assigneeDisplayName ?? "未割当";
  return `- ${issue.issueId} | ${title} | ${assignee} | ${issue.riskSummary}`;
}

function formatSlackAssigneeLabel(followup: ManagerReviewFollowup): string {
  if (followup.shouldMention && followup.slackUserId) {
    return `<@${followup.slackUserId}>`;
  }
  return followup.assigneeDisplayName ?? "未割当";
}

export function formatControlRoomFollowupForSlack(followup: ManagerReviewFollowup, threadReference: string): string {
  const answerFormat = followup.acceptableAnswerHint ?? acceptableAnswerHintForRequestKind(followup.requestKind);
  return [
    "要返信:",
    followup.issueId,
    formatSlackAssigneeLabel(followup),
    followup.request,
    `返答フォーマット: ${answerFormat}`,
    `戻る thread: ${threadReference}`,
  ].join(" | ");
}

export function formatManagerReviewFollowupLine(followup: ManagerReviewFollowup, threadReference: string): string {
  return formatControlRoomFollowupForSlack(followup, threadReference);
}

export function formatControlRoomReviewForSlack(result: ManagerReviewResult, threadReference?: string): string {
  const lines: string[] = [];

  if (result.kind === "morning-review") {
    lines.push("朝の execution review");
  } else if (result.kind === "evening-review") {
    lines.push("夕方の execution review");
  } else if (result.kind === "weekly-review") {
    lines.push("週次 planning review");
  } else {
    lines.push("緊急フォロー");
  }

  for (const summary of result.summaryLines ?? []) {
    lines.push(summary.startsWith("- ") ? summary : `- ${summary}`);
  }
  for (const issueLine of (result.issueLines ?? []).slice(0, 3)) {
    lines.push(formatIssueLineForSlack(issueLine));
  }
  if (result.followup) {
    lines.push(formatControlRoomFollowupForSlack(result.followup, threadReference ?? "source thread unavailable"));
  }

  if (lines.length === 1) {
    return result.text;
  }
  return lines.join("\n");
}

function resolveFollowupEntry(
  entry: FollowupLedgerEntry,
  now: Date,
  reason: "response" | "risk-cleared" | "completed" | "answered",
): FollowupLedgerEntry {
  return {
    ...entry,
    status: "resolved",
    resolvedAt: nowIso(now),
    resolvedReason: reason,
  };
}

function issueNeedsFollowupResponse(
  followups: FollowupLedgerEntry[],
  issueId: string,
): FollowupLedgerEntry | undefined {
  return followups.find((entry) => entry.issueId === issueId && entry.status === "awaiting-response");
}

function requestKindToSignalKind(
  requestKind: ManagerReviewFollowup["requestKind"] | undefined,
): Exclude<ManagerMessageKind, "conversation" | "request"> {
  return requestKind === "blocked-details" ? "blocked" : "progress";
}

function buildFollowupResponseComment(message: ManagerSlackMessage, followup: FollowupLedgerEntry): string {
  return [
    "## Follow-up response",
    `- requestKind: ${followup.requestKind ?? "status"}`,
    `- requestText: ${followup.requestText ?? "(none)"}`,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}

function updateFollowupsWithIssueResponse(
  followups: FollowupLedgerEntry[],
  issues: LinearIssue[],
  kind: Exclude<ManagerMessageKind, "conversation" | "request"> | "followup-response",
  responseText: string,
  now: Date,
): FollowupLedgerEntry[] {
  const issueById = new Map(issues.map((issue) => [issue.identifier, issue]));
  return followups.map((entry) => {
    const issue = issueById.get(entry.issueId);
    if (!issue || entry.status === "resolved") {
      return entry;
    }

    const next: FollowupLedgerEntry = {
      ...entry,
      lastResponseAt: nowIso(now),
      lastResponseKind: kind,
      lastResponseText: responseText.trim() || entry.lastResponseText,
    };

    if (issueMatchesCompletedState(issue)) {
      return resolveFollowupEntry(next, now, "completed");
    }

    return next;
  });
}

async function assessFollowupResponses(
  config: AppConfig,
  message: ManagerSlackMessage,
  followups: FollowupLedgerEntry[],
  issues: LinearIssue[],
  paths: ReturnType<typeof buildThreadPaths>,
  now: Date,
): Promise<FollowupLedgerEntry[]> {
  let nextFollowups = [...followups];

  for (const issue of issues) {
    const entry = issueNeedsFollowupResponse(nextFollowups, issue.identifier);
    if (!entry?.requestText || !entry.requestKind) continue;

    if (issueMatchesCompletedState(issue)) {
      nextFollowups = nextFollowups.map((candidate) => candidate.issueId === issue.identifier
        ? resolveFollowupEntry(candidate, now, "completed")
        : candidate);
      continue;
    }

    const assessment = await runFollowupResolutionTurn(
      config,
      paths,
      {
        issueId: issue.identifier,
        issueTitle: issue.title,
        requestKind: entry.requestKind,
        requestText: entry.requestText,
        acceptableAnswerHint: entry.acceptableAnswerHint,
        responseText: message.text,
        taskKey: `${issue.identifier}-${entry.requestKind}`,
      },
    ).catch<FollowupResolutionResult>(() => ({
      answered: false,
      confidence: 0,
      reasoningSummary: "follow-up resolution failed",
    }));

    nextFollowups = nextFollowups.map((candidate) => {
      if (candidate.issueId !== issue.identifier || candidate.status === "resolved") return candidate;
      const patched: FollowupLedgerEntry = {
        ...candidate,
        resolutionAssessment: {
          answered: assessment.answered,
          answerKind: assessment.answerKind,
          confidence: assessment.confidence,
          extractedFields: assessment.extractedFields,
        },
      };

      if (assessment.answered && assessment.confidence >= 0.7) {
        return resolveFollowupEntry(patched, now, "answered");
      }
      return patched;
    });
  }

  return nextFollowups;
}

async function applyFollowupExtractedFields(
  followup: FollowupLedgerEntry,
  issue: LinearIssue,
  assessment: FollowupResolutionResult,
  message: ManagerSlackMessage,
  env: Record<string, string | undefined>,
): Promise<LinearIssue> {
  const extracted = assessment.extractedFields ?? {};
  if (followup.requestKind === "owner" && extracted.assignee) {
    return updateManagedLinearIssue(
      {
        issueId: issue.identifier,
        assignee: extracted.assignee,
      },
      env,
    );
  }

  if (followup.requestKind === "due-date" && extracted.dueDate) {
    return updateManagedLinearIssue(
      {
        issueId: issue.identifier,
        dueDate: extracted.dueDate,
      },
      env,
    );
  }

  if (followup.requestKind === "status") {
    await addLinearProgressComment(issue.identifier, buildFollowupResponseComment(message, followup), env);
    return getLinearIssue(issue.identifier, env, undefined, { includeComments: true });
  }

  await addLinearComment(issue.identifier, buildFollowupResponseComment(message, followup), env);
  return getLinearIssue(issue.identifier, env, undefined, { includeComments: true });
}

function applyFollowupAssessmentResult(
  followups: FollowupLedgerEntry[],
  issueId: string,
  assessment: FollowupResolutionResult,
  now: Date,
  reason: "answered" | "risk-cleared" | "completed" | undefined,
): FollowupLedgerEntry[] {
  return followups.map((entry) => {
    if (entry.issueId !== issueId) return entry;
    const patched: FollowupLedgerEntry = {
      ...entry,
      resolutionAssessment: {
        answered: assessment.answered,
        answerKind: assessment.answerKind,
        confidence: assessment.confidence,
        extractedFields: assessment.extractedFields,
      },
    };

    if (reason) {
      return resolveFollowupEntry(patched, now, reason);
    }
    return patched;
  });
}

function formatAutonomousCreateReply(
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
    detailLines.unshift(options?.reusedParent
      ? `調査 task: ${buildSlackTargetLabel(children[0])} を既存の親 issue 配下に追加しました。`
      : `調査 task: ${buildSlackTargetLabel(children[0])} を作成しました。`);
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

function formatExistingIssueReply(duplicates: LinearIssue[]): string {
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

function formatStatusReply(
  kind: Exclude<ManagerMessageKind, "conversation" | "request">,
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

function formatFollowupResolutionReply(
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

function buildResearchSlackSummary(args: {
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
    return "原因と、誰の返答待ちか、何がそろえば再開できるかを共有してください。";
  }
  if (primaryCategory === "overdue" || primaryCategory === "due_today" || primaryCategory === "due_soon") {
    return "現在の進捗と次アクション、次回更新予定を共有してください。";
  }
  if (primaryCategory === "owner_missing") {
    return "担当者を 1 人決めて共有してください。";
  }
  if (primaryCategory === "due_missing") {
    return "期限を YYYY-MM-DD で共有してください。";
  }
  return "最新状況と次アクション、次回更新予定を共有してください。";
}

function requestKindForRiskCategory(category: string): ManagerReviewFollowup["requestKind"] {
  if (category === "blocked") return "blocked-details";
  if (category === "owner_missing") return "owner";
  if (category === "due_missing") return "due-date";
  return "status";
}

function acceptableAnswerHintForRequestKind(requestKind: ManagerReviewFollowup["requestKind"]): string {
  if (requestKind === "blocked-details") {
    return "原因 / 待ち先 / 再開条件";
  }
  if (requestKind === "owner") {
    return "担当者名";
  }
  if (requestKind === "due-date") {
    return "YYYY-MM-DD";
  }
  return "進捗 / 次アクション / 次回更新予定";
}

function resolveSlackUserIdForReview(
  ownerMap: OwnerMap,
  assigneeDisplayName: string | undefined,
): string | undefined {
  if (!assigneeDisplayName) return undefined;
  const normalizedAssignee = normalizeText(assigneeDisplayName);
  return ownerMap.entries.find((entry) => {
    if (!entry.slackUserId) return false;
    return normalizeText(entry.linearAssignee) === normalizedAssignee || normalizeText(entry.id) === normalizedAssignee;
  })?.slackUserId;
}

function shouldMentionReviewFollowup(
  category: string,
  existingFollowup?: FollowupLedgerEntry,
): boolean {
  if (["blocked", "overdue", "due_today"].includes(category)) {
    return true;
  }
  return existingFollowup?.status === "awaiting-response" && Boolean(existingFollowup.lastPublicFollowupAt);
}

function buildReviewFollowup(
  item: RiskAssessment,
  intakeLedger: IntakeLedgerEntry[],
  ownerMap: OwnerMap,
  existingFollowup?: FollowupLedgerEntry,
): ManagerReviewFollowup {
  const riskCategory = getPrimaryRiskCategory(item);
  const requestKind = existingFollowup?.requestKind ?? requestKindForRiskCategory(riskCategory);
  const assigneeDisplayName = existingFollowup?.assigneeDisplayName ?? item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? undefined;
  return {
    issueId: item.issue.identifier,
    issueTitle: item.issue.title,
    request: existingFollowup?.requestText ?? formatReviewFollowupPrompt(item),
    requestKind,
    acceptableAnswerHint: existingFollowup?.acceptableAnswerHint ?? acceptableAnswerHintForRequestKind(requestKind),
    assigneeDisplayName,
    slackUserId: resolveSlackUserIdForReview(ownerMap, assigneeDisplayName),
    riskCategory,
    shouldMention: shouldMentionReviewFollowup(riskCategory, existingFollowup),
    source: existingFollowup?.sourceChannelId && existingFollowup?.sourceThreadTs && existingFollowup?.sourceMessageTs
      ? {
          channelId: existingFollowup.sourceChannelId,
          rootThreadTs: existingFollowup.sourceThreadTs,
          sourceMessageTs: existingFollowup.sourceMessageTs,
        }
      : findLatestIssueSource(intakeLedger, item.issue.identifier),
  };
}

function buildAwaitingFollowupPatch(
  followups: FollowupLedgerEntry[],
  followup: ManagerReviewFollowup,
  category: string,
  now: Date,
): FollowupLedgerEntry {
  const existing = followups.find((entry) => entry.issueId === followup.issueId);
  return {
    issueId: followup.issueId,
    lastPublicFollowupAt: nowIso(now),
    lastCategory: category,
    requestKind: followup.requestKind,
    status: "awaiting-response",
    requestText: followup.request,
    acceptableAnswerHint: followup.acceptableAnswerHint,
    sourceChannelId: followup.source?.channelId,
    sourceThreadTs: followup.source?.rootThreadTs,
    sourceMessageTs: followup.source?.sourceMessageTs,
    assigneeDisplayName: followup.assigneeDisplayName,
    rePingCount: existing?.status === "awaiting-response" ? (existing.rePingCount ?? 0) + 1 : 0,
    resolvedAt: undefined,
    resolvedReason: undefined,
    lastResponseAt: existing?.status === "awaiting-response" ? existing.lastResponseAt : undefined,
    lastResponseKind: existing?.status === "awaiting-response" ? existing.lastResponseKind : undefined,
    lastResponseText: existing?.status === "awaiting-response" ? existing.lastResponseText : undefined,
    resolutionAssessment: existing?.status === "awaiting-response" ? existing.resolutionAssessment : undefined,
  };
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

  const eligible = items.filter((item) => !shouldSuppressFollowup(
    followups,
    item.issue.identifier,
    getPrimaryRiskCategory(item),
    policy.followupCooldownHours,
    now,
  ));
  const awaitingIssueIds = new Set(
    followups
      .filter((entry) => entry.status === "awaiting-response")
      .map((entry) => entry.issueId),
  );
  return eligible.find((item) => awaitingIssueIds.has(item.issue.identifier)) ?? eligible[0];
}

function findAwaitingFollowupCandidates(
  followups: FollowupLedgerEntry[],
  message: ManagerSlackMessage,
  controlRoomChannelId: string,
): FollowupLedgerEntry[] {
  const explicitIssueIds = new Set(extractIssueIdentifiers(message.text));
  return followups.filter((entry) => {
    if (entry.status !== "awaiting-response") return false;
    if (entry.sourceChannelId === message.channelId && entry.sourceThreadTs === message.rootThreadTs) return true;
    if (message.channelId === controlRoomChannelId && explicitIssueIds.has(entry.issueId)) return true;
    return false;
  });
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

function reconcileFollowupsWithRiskyIssues(
  followups: FollowupLedgerEntry[],
  risky: RiskAssessment[],
  now: Date,
): { changed: boolean; followups: FollowupLedgerEntry[] } {
  const riskyByIssueId = new Map(risky.map((item) => [item.issue.identifier, item]));
  let changed = false;
  const next = followups.map((entry) => {
    if (entry.status !== "awaiting-response") {
      return entry;
    }

    const current = riskyByIssueId.get(entry.issueId);
    if (!current) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (issueMatchesCompletedState(current.issue)) {
      changed = true;
      return resolveFollowupEntry(entry, now, "completed");
    }

    if (entry.lastCategory === "owner_missing" && !current.ownerMissing) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (entry.lastCategory === "due_missing" && !current.dueMissing) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    if (entry.lastCategory === "blocked" && !current.blocked) {
      changed = true;
      return resolveFollowupEntry(entry, now, "risk-cleared");
    }

    return entry;
  });

  return { changed, followups: next };
}

interface ManagerReviewData {
  policy: ManagerPolicy;
  ownerMap: OwnerMap;
  followups: FollowupLedgerEntry[];
  planningLedger: PlanningLedgerEntry[];
  intakeLedger: IntakeLedgerEntry[];
  risky: RiskAssessment[];
}

async function loadManagerReviewData(
  config: AppConfig,
  systemPaths: SystemPaths,
  now: Date,
): Promise<ManagerReviewData> {
  const policy = await loadManagerPolicy(systemPaths);
  const ownerMap = await loadOwnerMap(systemPaths);
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

  const reconciled = reconcileFollowupsWithRiskyIssues(followups, risky, now);
  if (reconciled.changed) {
    await saveFollowupsLedger(systemPaths, reconciled.followups);
  }

  return {
    policy,
    ownerMap,
    followups: reconciled.followups,
    planningLedger,
    intakeLedger,
    risky,
  };
}

export async function buildHeartbeatReviewDecision(
  config: AppConfig,
  systemPaths: SystemPaths,
  now = new Date(),
): Promise<HeartbeatReviewDecision> {
  const { policy, ownerMap, followups, intakeLedger, risky } = await loadManagerReviewData(config, systemPaths, now);

  if (!isWithinBusinessHours(policy, now)) {
    return { reason: "outside-business-hours" };
  }

  const urgent = sortRiskyIssues(risky).filter((item) => isUrgentRisk(item, policy));
  if (urgent.length === 0) {
    return { reason: "no-urgent-items" };
  }

  const available = urgent.filter((item) => !shouldSuppressFollowup(
    followups,
    item.issue.identifier,
    getPrimaryRiskCategory(item),
    policy.followupCooldownHours,
    now,
  ));

  if (available.length === 0) {
    return { reason: "suppressed-by-cooldown" };
  }

  const top = available[0];
  const existingFollowup = followups.find((entry) => entry.issueId === top.issue.identifier);
  const followup = buildReviewFollowup(top, intakeLedger, ownerMap, existingFollowup);
  const nextFollowups = upsertFollowup(
    followups,
    buildAwaitingFollowupPatch(followups, followup, getPrimaryRiskCategory(top), now),
  );
  await saveFollowupsLedger(systemPaths, nextFollowups);

  return {
    review: {
      kind: "heartbeat",
      text: [
        "緊急フォローが必要です。",
        formatRiskLine(top),
      ].join("\n"),
      summaryLines: ["blocked / overdue / due today の優先確認が必要です。"],
      issueLines: [{
        issueId: top.issue.identifier,
        title: top.issue.title,
        assigneeDisplayName: top.issue.assignee?.displayName ?? top.issue.assignee?.name ?? undefined,
        riskSummary: top.riskCategories.join(", "),
      }],
      followup,
    },
  };
}

export async function handleManagerMessage(
  config: AppConfig,
  systemPaths: SystemPaths,
  message: ManagerSlackMessage,
  now = new Date(),
): Promise<ManagerHandleResult> {
  const policy = await loadManagerPolicy(systemPaths);
  const intakeLedger = await loadIntakeLedger(systemPaths);
  const followups = await loadFollowupsLedger(systemPaths);
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
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  if (!pendingClarification) {
    const awaitingFollowups = findAwaitingFollowupCandidates(followups, message, policy.controlRoomChannelId);
    if (awaitingFollowups.length > 0) {
      let selectedFollowup = awaitingFollowups.length === 1 ? awaitingFollowups[0] : undefined;

      if (!selectedFollowup) {
        const explicitIssueIds = extractIssueIdentifiers(message.text);
        if (explicitIssueIds.length === 1) {
          selectedFollowup = awaitingFollowups.find((entry) => entry.issueId === explicitIssueIds[0]);
        }
      }

      if (!selectedFollowup) {
        return {
          handled: true,
          reply: formatIssueSelectionReply("progress", awaitingFollowups.map((entry) => ({
            issueId: entry.issueId,
            title: undefined,
          }))),
        };
      }

      if (selectedFollowup) {
        const issue = await getLinearIssue(selectedFollowup.issueId, env, undefined, { includeComments: true });
        const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
        const assessment = await runFollowupResolutionTurn(
          config,
          paths,
          {
            issueId: issue.identifier,
            issueTitle: issue.title,
            requestKind: selectedFollowup.requestKind ?? "status",
            requestText: selectedFollowup.requestText ?? formatReviewFollowupPrompt(assessRisk(issue, policy, now)),
            acceptableAnswerHint: selectedFollowup.acceptableAnswerHint,
            responseText: message.text,
            taskKey: `${issue.identifier}-followup`,
          },
        ).catch<FollowupResolutionResult>(() => ({
          answered: false,
          confidence: 0,
          reasoningSummary: "follow-up resolution failed",
        }));

        let updatedIssue = issue;
        let resolveReason: "answered" | "risk-cleared" | "completed" | undefined;
        if (selectedFollowup.requestKind === "owner" && assessment.extractedFields?.assignee) {
          updatedIssue = await applyFollowupExtractedFields(selectedFollowup, issue, assessment, message, env);
          resolveReason = updatedIssue.assignee ? "risk-cleared" : undefined;
        } else if (selectedFollowup.requestKind === "due-date" && assessment.extractedFields?.dueDate) {
          updatedIssue = await applyFollowupExtractedFields(selectedFollowup, issue, assessment, message, env);
          resolveReason = updatedIssue.dueDate ? "risk-cleared" : undefined;
        } else if (
          selectedFollowup.requestKind === "status"
          || selectedFollowup.requestKind === "blocked-details"
          || (assessment.answered && assessment.confidence >= 0.7)
        ) {
          updatedIssue = await applyFollowupExtractedFields(selectedFollowup, issue, assessment, message, env);
          if (assessment.answered && assessment.confidence >= 0.7) {
            resolveReason = issueMatchesCompletedState(updatedIssue) ? "completed" : "answered";
          }
        }

        let nextFollowups = updateFollowupsWithIssueResponse(followups, [updatedIssue], "followup-response", message.text, now);
        nextFollowups = applyFollowupAssessmentResult(nextFollowups, updatedIssue.identifier, assessment, now, resolveReason);
        await saveFollowupsLedger(systemPaths, nextFollowups);

        const nextLedger = upsertThreadIntakeEntry(
          intakeLedger,
          message,
          {
            lastResolvedIssueId: updatedIssue.identifier,
            issueFocusHistory: [buildIssueFocusEvent(updatedIssue.identifier, "followup-response", "followup", message.text, now)],
          },
          now,
        );
        await saveIntakeLedger(systemPaths, nextLedger);

        return {
          handled: true,
          reply: formatFollowupResolutionReply(selectedFollowup, updatedIssue, assessment),
        };
      }
    }
  }

  if (signal !== "request" && signal !== "conversation") {
    if (!policy.autoStatusUpdate) {
      return { handled: false };
    }
    const resolution = await resolveIssueTargetsFromThread(intakeLedger, message, signal, config.workspaceDir, env);
    if (resolution.reason === "missing" || resolution.reason === "ambiguous") {
      return {
        handled: true,
        reply: formatIssueSelectionReply(signal, resolution.candidates),
      };
    }

    const targetIssueIds = resolution.selectedIssueIds;
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
        issueFocusHistory: targetIssueIds.map((issueId) => buildIssueFocusEvent(issueId, signal, "thread-status", message.text, now)),
      },
      now,
    );
    await saveIntakeLedger(systemPaths, nextLedger);
    const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
    const followupState = updateFollowupsWithIssueResponse(followups, updatedIssues, signal, message.text, now);
    await saveFollowupsLedger(systemPaths, await assessFollowupResponses(config, message, followupState, updatedIssues, paths, now));

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
      issueFocusHistory: [],
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
        issueFocusHistory: duplicates.length === 1 && duplicates[0]
          ? [buildIssueFocusEvent(duplicates[0].identifier, "reuse", "duplicate-reuse", requestMessage.text, now)]
          : [],
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
    ? [`調査: ${planningTitle}`]
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
    createdChildren = compactLinearIssues(batch.children);
    if (createdChildren.length !== plannedChildren.length) {
      throw new Error(`Linear batch create returned ${createdChildren.length}/${plannedChildren.length} children`);
    }
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

      if (!createdChild) {
        throw new Error(`Linear create returned no issue for child: ${child.title}`);
      }

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

    const existingTitles = [parent?.title, ...createdChildren.map((issue) => issue.title)].filter(Boolean) as string[];
    const researchPaths = buildThreadPaths(config.workspaceDir, requestMessage.channelId, requestMessage.rootThreadTs);
    const rawResearchSynthesis = await runResearchSynthesisTurn(
      config,
      researchPaths,
      {
        channelId: requestMessage.channelId,
        rootThreadTs: requestMessage.rootThreadTs,
        taskTitle: planningTitle,
        sourceMessage: requestMessage.text,
        slackThreadSummary: formatSlackContextSummary(slackThreadContext.entries),
        recentChannelSummary: recentChannelContexts.length > 0
          ? recentChannelContexts
            .slice(0, 3)
            .map((context) => `- ${context.rootThreadTs}: ${context.entries.slice(-1)[0]?.text.replace(/\s+/g, " ").slice(0, 120) ?? "(no messages)"}`)
            .join("\n")
          : "- 直近 thread 文脈は取得できませんでした。",
        relatedIssuesSummary: formatRelatedIssuesSummary(relatedIssues),
        webSummary: formatWebSummary(searchResults, fetchedPages),
        taskKey: researchChild.identifier,
      },
    ).catch(() => buildFallbackResearchSynthesis({
      slackThreadEntries: slackThreadContext.entries,
      relatedIssues,
      searchResults,
    }));
    const researchSynthesis: ResearchSynthesisResult = {
      ...rawResearchSynthesis,
      nextActions: filterResearchNextActions(rawResearchSynthesis.nextActions, existingTitles, policy),
    };

    await updateManagedLinearIssue(
      {
        issueId: researchChild.identifier,
        description: buildResearchIssueDescription({
          sourceMessage: requestMessage,
          synthesis: researchSynthesis,
        }),
      },
      env,
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
        synthesis: researchSynthesis,
      }),
      env,
    );

    const followupChildren: LinearIssue[] = [];
    if (policy.autoPlan && researchSynthesis.nextActions.length >= policy.researchAutoPlanMinActions) {
      const parentAssignee = parent?.assignee?.displayName ?? parent?.assignee?.name;
      for (const nextAction of researchSynthesis.nextActions.slice(0, policy.researchAutoPlanMaxChildren)) {
        if (nextAction.title.trim().length < 6) {
          continue;
        }
        const owner = chooseOwner(nextAction.ownerHint ?? nextAction.title, ownerMap);
        if (owner.resolution === "fallback") {
          usedFallbackOwners.add(owner.entry.id);
        }

        const followupChild = await createManagedLinearIssue(
          {
            title: nextAction.title,
            description: [
              "## Research source",
              formatIssueReference(researchChild),
              "",
              "## Purpose",
              nextAction.purpose || "調査結果を踏まえて実行可能な状態にする",
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
      issueFocusHistory: [
        ...(parent ? [buildIssueFocusEvent(parent.identifier, research ? "research-parent" : "create-parent", planningReason, requestMessage.text, now)] : []),
        ...allCreatedChildren.map((issue) => buildIssueFocusEvent(
          issue.identifier,
          issue.identifier === researchChild.identifier ? "research-child" : "create-child",
          planningReason,
          issue.title,
          now,
        )),
      ],
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
        synthesis: researchSynthesis,
        followupChildren,
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
    issueFocusHistory: [
      ...(parent ? [buildIssueFocusEvent(parent.identifier, "create-parent", planningReason, requestMessage.text, now)] : []),
      ...createdChildren.map((issue) => buildIssueFocusEvent(issue.identifier, "create-child", planningReason, issue.title, now)),
    ],
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
): Promise<ManagerReviewResult | undefined> {
  if (kind === "heartbeat") {
    const decision = await buildHeartbeatReviewDecision(config, systemPaths, now);
    return decision.review;
  }

  const { policy, ownerMap, followups, planningLedger, intakeLedger, risky } = await loadManagerReviewData(config, systemPaths, now);

  const sorted = sortRiskyIssues(risky);
  if (kind === "morning-review") {
    const lines = ["朝の execution review です。"];
    const items = sorted.filter((item) => !item.riskCategories.includes("due_missing")).slice(0, 3);
    if (items.length === 0) {
      return {
        kind,
        text: "朝の execution review です。\n- 今日すぐに共有すべきリスクはありません。",
        summaryLines: ["今日すぐに共有すべきリスクはありません。"],
      };
    }
    lines.push("今日やるべきこと / 期限リスク / stale:");
    for (const item of items) lines.push(formatRiskLine(item));
    const followupItem = selectReviewFollowupItem(items, followups, policy, now);
    let followup: ManagerReviewFollowup | undefined;
    if (followupItem) {
      const existingFollowup = followups.find((entry) => entry.issueId === followupItem.issue.identifier);
      followup = buildReviewFollowup(followupItem, intakeLedger, ownerMap, existingFollowup);
      await saveFollowupsLedger(systemPaths, upsertFollowup(
        followups,
        buildAwaitingFollowupPatch(followups, followup, getPrimaryRiskCategory(followupItem), now),
      ));
    }
    return {
      kind,
      text: lines.join("\n"),
      summaryLines: ["今日やるべきこと / 期限リスク / stale"],
      issueLines: items.map((item) => ({
        issueId: item.issue.identifier,
        title: item.issue.title,
        assigneeDisplayName: item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? undefined,
        riskSummary: item.riskCategories.join(", "),
      })),
      followup,
    };
  }

  if (kind === "evening-review") {
    const lines = ["夕方の進捗 review です。"];
    const items = sorted
      .filter((item) => item.riskCategories.some((category) => ["due_today", "blocked", "overdue", "stale"].includes(category)))
      .slice(0, 3);
    if (items.length === 0) {
      return {
        kind,
        text: "夕方の進捗 review です。\n- 今日の残タスクで強いリスクは見当たりません。",
        summaryLines: ["今日の残タスクで強いリスクは見当たりません。"],
      };
    }
    lines.push("今日残っていること / blocked / due today:");
    for (const item of items) lines.push(formatRiskLine(item));
    const followupItem = selectReviewFollowupItem(items, followups, policy, now);
    let followup: ManagerReviewFollowup | undefined;
    if (followupItem) {
      const existingFollowup = followups.find((entry) => entry.issueId === followupItem.issue.identifier);
      followup = buildReviewFollowup(followupItem, intakeLedger, ownerMap, existingFollowup);
      await saveFollowupsLedger(systemPaths, upsertFollowup(
        followups,
        buildAwaitingFollowupPatch(followups, followup, getPrimaryRiskCategory(followupItem), now),
      ));
    }
    return {
      kind,
      text: lines.join("\n"),
      summaryLines: ["残タスク / blocked / due today"],
      issueLines: items.map((item) => ({
        issueId: item.issue.identifier,
        title: item.issue.title,
        assigneeDisplayName: item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? undefined,
        riskSummary: item.riskCategories.join(", "),
      })),
      followup,
    };
  }

  const fallbackCount = planningLedger.filter((entry) => entry.ownerResolution === "fallback").length;
  const unresolvedClarifications = intakeLedger.filter((entry) => entry.status === "needs-clarification").length;
  const staleItems = sorted.filter((item) => item.riskCategories.includes("stale")).slice(0, 5);
  const lines = ["週次 planning review です。"];
  lines.push(`- 未整備 issue: ${sorted.filter((item) => item.ownerMissing || item.dueMissing).length}`);
  lines.push(`- 長期 stale: ${staleItems.length}`);
  lines.push(`- owner map gap: ${fallbackCount}`);
  lines.push(`- 未処理 clarification: ${unresolvedClarifications}`);
  for (const item of staleItems.slice(0, 3)) {
    lines.push(formatRiskLine(item));
  }
  const weeklyItems = staleItems.slice(0, 3);
  const followupItem = selectReviewFollowupItem(weeklyItems, followups, policy, now);
  let followup: ManagerReviewFollowup | undefined;
  if (followupItem) {
    const existingFollowup = followups.find((entry) => entry.issueId === followupItem.issue.identifier);
    followup = buildReviewFollowup(followupItem, intakeLedger, ownerMap, existingFollowup);
    await saveFollowupsLedger(systemPaths, upsertFollowup(
      followups,
      buildAwaitingFollowupPatch(followups, followup, getPrimaryRiskCategory(followupItem), now),
    ));
  }
  return {
    kind,
    text: lines.join("\n"),
    summaryLines: [
      `未整備 issue: ${sorted.filter((item) => item.ownerMissing || item.dueMissing).length}`,
      `長期 stale: ${staleItems.length}`,
      `owner map gap: ${fallbackCount}`,
      `未処理 clarification: ${unresolvedClarifications}`,
    ],
    issueLines: weeklyItems.map((item) => ({
      issueId: item.issue.identifier,
      title: item.issue.title,
      assigneeDisplayName: item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? undefined,
      riskSummary: item.riskCategories.join(", "),
    })),
    followup,
  };
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
