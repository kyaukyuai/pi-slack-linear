import type { AppConfig } from "./config.js";
import { handleIntakeRequest } from "../orchestrators/intake/handle-intake.js";
import {
  buildHeartbeatReviewDecision as buildHeartbeatReviewDecisionOrchestrator,
  buildManagerReview as buildManagerReviewOrchestrator,
} from "../orchestrators/review/build-review.js";
import type {
  HeartbeatReviewDecision,
  ManagerFollowupSource,
  ManagerReviewKind,
  ManagerReviewResult,
} from "../orchestrators/review/contract.js";
import { loadManagerReviewData } from "../orchestrators/review/review-data.js";
import {
  buildAwaitingFollowupPatch,
  buildReviewFollowup,
  formatReviewFollowupPrompt,
  formatRiskLine,
  getPrimaryRiskCategory,
  isUrgentRisk,
  isWithinBusinessHours,
  selectReviewFollowupItem,
  shouldSuppressFollowup,
  sortRiskyIssues,
  upsertFollowup,
} from "../orchestrators/review/review-helpers.js";
import {
  assessRisk,
  businessDaysSince,
} from "../orchestrators/review/risk.js";
import { handleManagerUpdates } from "../orchestrators/updates/handle-updates.js";
import {
  addLinearRelation,
  createManagedLinearIssue,
  createManagedLinearIssueBatch,
  searchLinearIssues,
  type LinearIssue,
} from "./linear.js";
import {
  loadFollowupsLedger,
  loadIntakeLedger,
  loadManagerPolicy,
  saveIntakeLedger,
  savePlanningLedger,
  type IntakeLedgerEntry,
  type ManagerPolicy,
  type OwnerMap,
  type OwnerMapEntry,
} from "./manager-state.js";
import {
  runResearchSynthesisTurn,
  runTaskPlanningTurn,
  type ResearchNextAction,
  type ResearchSynthesisResult,
} from "./pi-session.js";
import { getRecentChannelContext, getSlackThreadContext } from "./slack-context.js";
import type { SystemPaths } from "./system-workspace.js";
import { webFetchUrl, webSearchFetch } from "./web-research.js";

export type ManagerMessageKind = "request" | "progress" | "completed" | "blocked" | "conversation";
export type ClarificationNeed = "scope" | "due_date" | "execution_plan";
export type {
  HeartbeatNoopReason,
  HeartbeatReviewDecision,
  ManagerFollowupSource,
  ManagerReviewFollowup,
  ManagerReviewIssueLine,
  ManagerReviewKind,
  ManagerReviewResult,
  RiskAssessment,
} from "../orchestrators/review/contract.js";
export {
  formatControlRoomFollowupForSlack,
  formatControlRoomReviewForSlack,
  formatIssueLineForSlack,
  formatManagerReviewFollowupLine,
} from "../orchestrators/review/review-helpers.js";
export { assessRisk, businessDaysSince } from "../orchestrators/review/risk.js";
export { formatIssueSelectionReply } from "../orchestrators/updates/target-resolution.js";

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

function hasExplicitTaskBreakdown(text: string): boolean {
  const bulletLines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => LIST_MARKER_PATTERN.test(line))
    .map((line) => stripLeadingListMarker(line))
    .filter(Boolean);

  if (bulletLines.length >= 2) return true;
  return extractInlineTaskSegments(text).length >= 2;
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

function isNarrativeTaskBreakdown(text: string, segments: string[]): boolean {
  if (segments.length < 2) return false;
  if (hasExplicitTaskBreakdown(text)) return false;

  const nonEmptyLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length >= 2;
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
  if (isNarrativeTaskBreakdown(text, segments)) {
    return deriveIssueTitle(segments[0] ?? text);
  }
  return research ? deriveResearchTitle(text) : deriveIssueTitle(text);
}

function filterChildSegmentsForPlanning(text: string, segments: string[], planningTitle: string): string[] {
  if (!isNarrativeTaskBreakdown(text, segments)) {
    return segments;
  }

  const normalizedParent = normalizeText(planningTitle);
  const filtered = segments.filter((segment) => normalizeText(deriveIssueTitle(segment)) !== normalizedParent);
  return filtered.length > 0 ? filtered : segments;
}

function inferDocumentHint(texts: string[]): string | undefined {
  for (const text of texts) {
    const normalized = text.replace(/\s+/g, " ").trim();
    const directMatch = normalized.match(/([^\s、,。]+書)(?=(?:の|を|へ|に|確認|ドラフト|作成|送付|レビュー|締結))/);
    if (directMatch?.[1]) {
      return directMatch[1];
    }
  }

  for (const text of texts) {
    if (/契約/.test(text)) {
      return "契約書";
    }
  }

  return undefined;
}

function normalizeNarrativeChildTitle(
  text: string,
  fallbackTitle: string,
  context: { requestText: string; planningTitle: string; segments: string[] },
): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const documentHint = inferDocumentHint([normalizedText, ...context.segments, context.requestText, context.planningTitle]);

  const confirmRequestMatch = normalizedText.match(/(?:.+?(?:後|完了後)[、,]\s*)?(.+?)(?:に|へ)確認依頼(?:を)?(?:する)?(?:必要あり|必要があります|が必要|予定|待ち|済み)?$/);
  if (confirmRequestMatch?.[1]) {
    const addressee = confirmRequestMatch[1].trim().replace(/\s+/g, " ");
    return `${addressee}へ${documentHint ? `${documentHint}` : ""}確認依頼`;
  }

  if (/ドラフト(?:版)?/.test(normalizedText) && /(作成|作成依頼|作成依頼済み)/.test(normalizedText)) {
    return "ドラフト作成";
  }

  return fallbackTitle
    .replace(/依頼済み$/g, "依頼")
    .replace(/(?:を|の)?作成依頼$/g, "作成")
    .replace(/(?:する)?必要があります$/g, "")
    .replace(/(?:する)?必要あり$/g, "")
    .replace(/(?:が)?必要です$/g, "")
    .replace(/(?:が)?必要$/g, "")
    .trim();
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

function compactLinearIssues(issues: Array<LinearIssue | undefined>): LinearIssue[] {
  return issues.filter((issue): issue is LinearIssue => Boolean(issue));
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

function trimJapaneseParticles(text: string): string {
  return text.replace(/(?:は|を|が|に|で|と|へ|も|の)+$/u, "").trim();
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

function formatIssueReference(issue: Pick<LinearIssue, "identifier" | "title"> & { url?: string | null }): string {
  return issue.url ? `<${issue.url}|${issue.identifier} ${issue.title}>` : `${issue.identifier} ${issue.title}`;
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

export async function buildHeartbeatReviewDecision(
  config: AppConfig,
  systemPaths: SystemPaths,
  now = new Date(),
): Promise<HeartbeatReviewDecision> {
  return buildHeartbeatReviewDecisionOrchestrator({
    config,
    systemPaths,
    now,
    helpers: {
      loadManagerReviewData,
      isWithinBusinessHours: (policy, candidateNow) => isWithinBusinessHours(policy, candidateNow, { toJstDate }),
      sortRiskyIssues,
      isUrgentRisk,
      shouldSuppressFollowup,
      buildReviewFollowup: (item, intakeLedger, ownerMap, existingFollowup) => buildReviewFollowup(
        item,
        intakeLedger,
        ownerMap,
        existingFollowup,
        { normalizeText, findLatestIssueSource },
      ),
      upsertFollowup,
      buildAwaitingFollowupPatch: (followups, followup, category, candidateNow) => buildAwaitingFollowupPatch(
        followups,
        followup,
        category,
        candidateNow,
        { nowIso },
      ),
      getPrimaryRiskCategory,
      formatRiskLine,
      selectReviewFollowupItem,
    },
  });
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

  const updatesResult = await handleManagerUpdates({
    config,
    systemPaths,
    message,
    now,
    signal,
    policy,
    intakeLedger,
    followups,
    allowFollowupResolution: !pendingClarification,
    env,
    helpers: {
      formatReviewFollowupPrompt,
      assessRisk,
      buildIssueFocusEvent,
      upsertThreadIntakeEntry,
    },
  });
  if (updatesResult) {
    return updatesResult;
  }

  if (signal !== "request") {
    return { handled: false };
  }

  if (!policy.autoCreate) {
    return { handled: false };
  }

  return handleIntakeRequest({
    config,
    systemPaths,
    message,
    now,
    policy,
    intakeLedger,
    pendingClarification,
    originalRequestText,
    requestMessage,
    env,
    helpers: {
      unique,
      nowIso,
      toJstDate,
      fingerprintText,
      buildIntakeKey,
      buildIssueFocusEvent,
      chooseExistingResearchParent,
      chooseOwner,
      compactLinearIssues,
      formatSourceComment,
      formatExistingIssueReply,
      formatSlackContextSummary,
      formatRelatedIssuesSummary,
      formatWebSummary,
      buildFallbackResearchSynthesis,
      filterResearchNextActions,
      buildResearchIssueDescription,
      buildResearchComment,
      buildResearchSlackSummary,
      formatAutonomousCreateReply,
      formatIssueReference,
    },
  });
}

export async function buildManagerReview(
  config: AppConfig,
  systemPaths: SystemPaths,
  kind: ManagerReviewKind,
  now = new Date(),
): Promise<ManagerReviewResult | undefined> {
  return buildManagerReviewOrchestrator({
    config,
    systemPaths,
    kind,
    now,
    helpers: {
      loadManagerReviewData,
      isWithinBusinessHours: (policy, candidateNow) => isWithinBusinessHours(policy, candidateNow, { toJstDate }),
      sortRiskyIssues,
      isUrgentRisk,
      shouldSuppressFollowup,
      buildReviewFollowup: (item, intakeLedger, ownerMap, existingFollowup) => buildReviewFollowup(
        item,
        intakeLedger,
        ownerMap,
        existingFollowup,
        { normalizeText, findLatestIssueSource },
      ),
      upsertFollowup,
      buildAwaitingFollowupPatch: (followups, followup, category, candidateNow) => buildAwaitingFollowupPatch(
        followups,
        followup,
        category,
        candidateNow,
        { nowIso },
      ),
      getPrimaryRiskCategory,
      formatRiskLine,
      selectReviewFollowupItem,
    },
  });
}
