import type { AppConfig } from "./config.js";
import { handleIntakeRequest } from "../orchestrators/intake/handle-intake.js";
import { chooseOwner } from "../orchestrators/intake/planning-support.js";
import { findPendingClarification } from "../orchestrators/shared/intake-ledger.js";
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
import { createFileBackedManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import type { ManagerRepositories } from "../state/repositories/file-backed-manager-repositories.js";
import {
  type LinearIssue,
} from "./linear.js";
import {
  type IntakeLedgerEntry,
  type ManagerPolicy,
} from "../state/manager-state-contract.js";
import type { SystemPaths } from "./system-workspace.js";

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
export { chooseOwner } from "../orchestrators/intake/planning-support.js";

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

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function collectEntryIssueIds(entry: IntakeLedgerEntry): string[] {
  return unique([
    entry.lastResolvedIssueId,
    entry.parentIssueId,
    ...entry.childIssueIds,
  ].filter(Boolean)) as string[];
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

function isManagerRepositories(value: unknown): value is ManagerRepositories {
  return typeof value === "object"
    && value !== null
    && "policy" in value
    && "ownerMap" in value
    && "intake" in value
    && "followups" in value
    && "planning" in value;
}

export async function buildHeartbeatReviewDecision(
  config: AppConfig,
  systemPaths: SystemPaths,
  repositoriesOrNow?: ManagerRepositories | Date,
  maybeNow?: Date,
): Promise<HeartbeatReviewDecision> {
  const repositories = isManagerRepositories(repositoriesOrNow)
    ? repositoriesOrNow
    : createFileBackedManagerRepositories(systemPaths);
  const now = repositoriesOrNow instanceof Date ? repositoriesOrNow : (maybeNow ?? new Date());
  return buildHeartbeatReviewDecisionOrchestrator({
    config,
    repositories,
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
  repositoriesOrNow?: ManagerRepositories | Date,
  maybeNow?: Date,
): Promise<ManagerHandleResult> {
  const repositories = isManagerRepositories(repositoriesOrNow)
    ? repositoriesOrNow
    : createFileBackedManagerRepositories(systemPaths);
  const now = repositoriesOrNow instanceof Date ? repositoriesOrNow : (maybeNow ?? new Date());
  const policy = await repositories.policy.load();
  const intakeLedger = await repositories.intake.load();
  const followups = await repositories.followups.load();
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
    repositories,
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
      fingerprintText,
      nowIso,
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
    repositories,
    message,
    now,
    policy,
    intakeLedger,
    pendingClarification,
    originalRequestText,
    requestMessage,
    env,
    helpers: {
      toJstDate,
      fingerprintText,
      nowIso,
    },
  });
}

export async function buildManagerReview(
  config: AppConfig,
  systemPaths: SystemPaths,
  kind: ManagerReviewKind,
  repositoriesOrNow?: ManagerRepositories | Date,
  maybeNow?: Date,
): Promise<ManagerReviewResult | undefined> {
  const repositories = isManagerRepositories(repositoriesOrNow)
    ? repositoriesOrNow
    : createFileBackedManagerRepositories(systemPaths);
  const now = repositoriesOrNow instanceof Date ? repositoriesOrNow : (maybeNow ?? new Date());
  return buildManagerReviewOrchestrator({
    config,
    repositories,
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
