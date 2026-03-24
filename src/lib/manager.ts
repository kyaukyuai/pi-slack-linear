import type { AppConfig } from "./config.js";
import { handleIntakeRequest } from "../orchestrators/intake/handle-intake.js";
import { chooseOwner } from "../orchestrators/intake/planning-support.js";
import {
  buildHeartbeatReviewDecision as buildHeartbeatReviewDecisionOrchestrator,
  buildManagerReview as buildManagerReviewOrchestrator,
} from "../orchestrators/review/build-review.js";
import {
  classifyManagerQuery,
  handleManagerQuery,
  type ManagerQueryKind,
} from "../orchestrators/query/handle-query.js";
import {
  runManagerAgentTurn,
  runManagerReplyTurn,
  runMessageRouterTurn,
  type MessageRouterInput,
  type MessageRouterResult,
} from "./pi-session.js";
import type {
  HeartbeatReviewDecision,
  ManagerReviewKind,
  ManagerReviewResult,
} from "../orchestrators/review/contract.js";
import { loadManagerReviewData } from "../orchestrators/review/review-data.js";
import {
  buildAwaitingFollowupPatch,
  buildIssueRiskSummary,
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
import { composeSlackReply, formatSlackBullets, joinSlackSentences } from "../orchestrators/shared/slack-conversation.js";
import {
  commitManagerCommandProposals,
  type ManagerIntentReport,
  type PendingClarificationDecisionReport,
} from "./manager-command-commit.js";
import {
  type LinearIssue,
} from "./linear.js";
import {
  type ManagerPolicy,
} from "../state/manager-state-contract.js";
import { buildWorkgraphThreadKey } from "../state/workgraph/events.js";
import {
  getPendingClarificationForThread,
  getThreadPlanningContext,
} from "../state/workgraph/queries.js";
import { getSlackThreadContext } from "./slack-context.js";
import { saveLastManagerAgentTurn } from "./last-manager-agent-turn.js";
import type { SystemPaths } from "./system-workspace.js";
import { buildThreadPaths, ensureThreadWorkspace, type ThreadPaths } from "./thread-workspace.js";
import {
  clearThreadQueryContinuation,
  loadThreadQueryContinuation,
  saveThreadQueryContinuation,
  type ThreadQueryReferenceItem,
  type ThreadQueryContinuation,
  type ThreadQueryKind,
  type ThreadQueryScope,
} from "./query-continuation.js";
import {
  clearPendingManagerClarification,
  isPendingManagerClarificationContinuation,
  isPendingManagerClarificationStatusQuestion,
  loadPendingManagerClarification,
  savePendingManagerClarification,
  type PendingManagerClarification,
} from "./pending-manager-clarification.js";

export type ManagerMessageKind = "request" | "query" | "progress" | "completed" | "blocked" | "conversation";
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
export type { ManagerQueryKind } from "../orchestrators/query/handle-query.js";
export {
  formatControlRoomFollowupForSlack,
  formatControlRoomReviewForSlack,
  formatIssueLineForSlack,
  formatManagerReviewFollowupLine,
} from "../orchestrators/review/review-helpers.js";
export { assessRisk, businessDaysSince } from "../orchestrators/review/risk.js";
export { formatIssueSelectionReply } from "../orchestrators/updates/target-resolution.js";
export { chooseOwner } from "../orchestrators/intake/planning-support.js";
export { classifyManagerQuery } from "../orchestrators/query/handle-query.js";

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
  diagnostics?: {
    agent?: {
      source: "agent" | "fallback";
      intent?: ManagerIntentReport["intent"];
      queryKind?: ManagerIntentReport["queryKind"];
      queryScope?: ManagerIntentReport["queryScope"];
      confidence?: number;
      reasoningSummary?: string;
      toolCalls: string[];
      proposalCount: number;
      invalidProposalCount?: number;
      committedCommands: string[];
      commitRejections: string[];
      pendingClarificationDecision?: PendingClarificationDecisionReport["decision"];
      pendingClarificationPersistence?: PendingClarificationDecisionReport["persistence"];
      pendingClarificationDecisionSummary?: string;
      missingQuerySnapshot?: boolean;
      technicalFailure?: string;
    };
    router?: {
      source: "llm" | "fallback";
      action: MessageRouterResult["action"] | ManagerMessageKind;
      queryKind?: ManagerQueryKind;
      queryScope?: "self" | "team" | "thread-context";
      confidence?: number;
      reasoningSummary?: string;
      technicalFailure?: string;
    };
  };
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
const GREETING_PATTERN = /^(?:おはよう|こんにちは|こんばんは|お疲れさま|おつかれさま)(?:ございます)?[。！!？?]*$/i;
const REFERENCE_QUERY_PATTERN = /((?:notion|ノーション|slack|スラック|ドキュメント|docs?|メモ).*(?:確認|見て|検索|探して|調べ|読んで)|(?:確認|見て|検索|探して|調べ|読んで).*(?:notion|ノーション|slack|スラック|ドキュメント|docs?|メモ))/i;
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

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
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
  if (classifyManagerQuery(normalized)) return "query";
  if (BLOCKED_PATTERN.test(normalized)) return "blocked";
  if (COMPLETED_PATTERN.test(normalized)) return "completed";
  if (PROGRESS_PATTERN.test(normalized)) return "progress";
  if (REFERENCE_QUERY_PATTERN.test(normalized)) return "query";
  if (RESEARCH_PATTERN.test(normalized)) return "request";
  if (REQUEST_PATTERN.test(normalized)) return "request";
  return "conversation";
}

function currentDateInJst(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function detectFallbackConversationKind(text: string): "greeting" | "smalltalk" | "other" {
  if (GREETING_PATTERN.test(text.trim())) {
    return "greeting";
  }
  if (/[?？]$/.test(text.trim())) {
    return "smalltalk";
  }
  return "other";
}

function buildFallbackConversationReply(kind: "greeting" | "smalltalk" | "other"): string {
  if (kind === "greeting") {
    return "こんばんは。確認したいことや進めたい task があれば、そのまま送ってください。";
  }
  if (kind === "smalltalk") {
    return "確認したいことがあれば、そのまま続けて送ってください。状況確認でも task 追加でも大丈夫です。";
  }
  return "必要なことがあれば、そのまま続けて送ってください。状況確認でも task の相談でも対応します。";
}

function buildSafetyQueryReply(): string {
  return "いまは一覧や優先順位を安全に判断できないため、issue ID か条件をもう少し具体的に教えてください。";
}

function buildCommitRejectionReply(rejections: string[]): string | undefined {
  if (rejections.length === 0) return undefined;
  if (rejections.length === 1) {
    return `今回は ${rejections[0]} ため、すぐには確定できませんでした。必要なら少し補足してください。`;
  }
  return composeSlackReply([
    "いくつか確認したい点があり、そのままでは確定できませんでした。",
    formatSlackBullets(rejections),
    "必要なら少し補足してください。",
  ]);
}

function isMutableIntent(
  intent: ManagerIntentReport["intent"] | undefined,
): intent is "create_work" | "update_progress" | "update_completed" | "update_blocked" | "followup_resolution" {
  return intent === "create_work"
    || intent === "update_progress"
    || intent === "update_completed"
    || intent === "update_blocked"
    || intent === "followup_resolution";
}

function originalMessageForPendingClarification(
  pendingClarification: PendingManagerClarification | undefined,
  decision: PendingClarificationDecisionReport["decision"] | undefined,
  messageText: string,
): string {
  if (decision === "continue_pending" && pendingClarification) {
    return pendingClarification.originalUserMessage;
  }
  return messageText;
}

async function persistPendingManagerClarification(args: {
  paths: ThreadPaths;
  intent: "create_work" | "update_progress" | "update_completed" | "update_blocked" | "followup_resolution";
  originalUserMessage: string;
  lastUserMessage: string;
  clarificationReply: string;
  missingDecisionSummary?: string;
  threadParentIssueId?: string;
  relatedIssueIds?: string[];
  now: Date;
}): Promise<void> {
  await savePendingManagerClarification(args.paths, {
    intent: args.intent,
    originalUserMessage: args.originalUserMessage,
    lastUserMessage: args.lastUserMessage,
    clarificationReply: args.clarificationReply,
    missingDecisionSummary: args.missingDecisionSummary,
    threadParentIssueId: args.threadParentIssueId,
    relatedIssueIds: unique(args.relatedIssueIds ?? []),
    recordedAt: args.now.toISOString(),
  });
}

function formatCommitLogs(commitSummaries: string[]): string {
  return commitSummaries
    .map((summary) => `> system log: ${summary}`)
    .join("\n");
}

function normalizeCommitSummaryForCompare(text: string): string {
  return text
    .replace(/<[^|>]+\|([^>]+)>/g, "$1")
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractSlackUrls(text: string): string[] {
  return Array.from(text.matchAll(/<([^|>\s]+)(?:\|[^>]+)?>/g))
    .map((match) => match[1] ?? "")
    .filter((value) => /^https?:\/\//.test(value));
}

function looksLikeFollowupSummary(summary: string): boolean {
  return /follow-up を作成しました/.test(summary);
}

function agentAlreadyCoversFollowup(agentReply: string, summary: string): boolean {
  const issueIds = Array.from(summary.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  if (issueIds.length === 0 || !issueIds.every((issueId) => agentReply.includes(issueId))) {
    return false;
  }
  return /(確認|follow-up|フォローアップ|送[り付信]|連絡)/.test(agentReply);
}

function shouldSuppressCommitSummary(agentReply: string, summary: string): boolean {
  const summaryUrls = extractSlackUrls(summary);
  if (summaryUrls.length > 0) {
    const agentUrls = extractSlackUrls(agentReply);
    const agentCoversUrls = summaryUrls.every((url) => agentUrls.includes(url));
    if (!agentCoversUrls) {
      return false;
    }
  }

  const normalizedAgentReply = normalizeCommitSummaryForCompare(agentReply);
  const normalizedSummary = normalizeCommitSummaryForCompare(summary);
  if (!normalizedAgentReply || !normalizedSummary) {
    return false;
  }
  if (normalizedAgentReply.includes(normalizedSummary)) {
    return true;
  }
  return looksLikeFollowupSummary(summary) && agentAlreadyCoversFollowup(agentReply, summary);
}

interface ThreadQueryContinuationSnapshotInput {
  issueIds?: string[];
  shownIssueIds?: string[];
  remainingIssueIds?: string[];
  totalItemCount?: number;
  replySummary?: string;
  scope?: ThreadQueryScope;
  referenceItems?: ThreadQueryReferenceItem[];
}

function normalizeQuerySnapshotIssueIds(values: unknown): string[] {
  return Array.isArray(values)
    ? Array.from(new Set(values.filter((value): value is string => typeof value === "string")))
    : [];
}

function normalizeQuerySnapshotReferenceItems(values: unknown): ThreadQueryReferenceItem[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = values.flatMap((entry): ThreadQueryReferenceItem[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim().length === 0) {
      return [];
    }

    return [{
      id: record.id.trim(),
      title: typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : undefined,
      url: typeof record.url === "string"
        ? record.url
        : record.url === null
          ? null
          : undefined,
      source: typeof record.source === "string" && record.source.trim()
        ? record.source.trim()
        : undefined,
    }];
  });

  if (normalized.length === 0) {
    return [];
  }

  const deduped = new Map<string, ThreadQueryReferenceItem>();
  for (const item of normalized) {
    deduped.set(item.id, item);
  }
  return Array.from(deduped.values());
}

function extractQuerySnapshot(toolCalls: Array<{ toolName: string; details?: unknown }>): ThreadQueryContinuationSnapshotInput | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.toolName !== "report_query_snapshot") {
      continue;
    }
    const details = toolCall.details as { querySnapshot?: Record<string, unknown> } | undefined;
    const snapshot = details?.querySnapshot;
    if (!snapshot) {
      continue;
    }
    const issueIds = normalizeQuerySnapshotIssueIds(snapshot.issueIds);
    const shownIssueIds = normalizeQuerySnapshotIssueIds(snapshot.shownIssueIds);
    const remainingIssueIds = normalizeQuerySnapshotIssueIds(snapshot.remainingIssueIds);
    const totalItemCount = typeof snapshot.totalItemCount === "number" && Number.isFinite(snapshot.totalItemCount) && snapshot.totalItemCount >= 0
      ? Math.trunc(snapshot.totalItemCount)
      : undefined;
    const replySummary = typeof snapshot.replySummary === "string" && snapshot.replySummary.trim()
      ? snapshot.replySummary.trim()
      : undefined;
    const scope = snapshot.scope === "self" || snapshot.scope === "team" || snapshot.scope === "thread-context"
      ? snapshot.scope
      : undefined;
    const referenceItems = normalizeQuerySnapshotReferenceItems(snapshot.referenceItems);
    return {
      issueIds,
      shownIssueIds,
      remainingIssueIds,
      totalItemCount,
      replySummary,
      scope,
      referenceItems,
    };
  }
  return undefined;
}

interface CompleteThreadQueryContinuationSnapshotInput {
  issueIds: string[];
  shownIssueIds: string[];
  remainingIssueIds: string[];
  totalItemCount: number;
  replySummary: string;
  scope: ThreadQueryScope;
  referenceItems?: ThreadQueryReferenceItem[];
}

function hasCompleteQuerySnapshot(
  snapshot: ThreadQueryContinuationSnapshotInput | undefined,
): snapshot is CompleteThreadQueryContinuationSnapshotInput {
  return Array.isArray(snapshot?.issueIds)
    && Array.isArray(snapshot?.shownIssueIds)
    && Array.isArray(snapshot?.remainingIssueIds)
    && typeof snapshot?.totalItemCount === "number"
    && Number.isFinite(snapshot.totalItemCount)
    && typeof snapshot?.replySummary === "string"
    && snapshot.replySummary.trim().length > 0
    && (snapshot?.scope === "self" || snapshot?.scope === "team" || snapshot?.scope === "thread-context");
}

function buildThreadQueryContinuation(args: {
  queryKind?: ThreadQueryKind;
  messageText: string;
  recordedAt: Date;
  snapshot: CompleteThreadQueryContinuationSnapshotInput;
}): ThreadQueryContinuation | undefined {
  if (!args.queryKind) {
    return undefined;
  }

  const userMessage = args.messageText.trim();
  return {
    kind: args.queryKind,
    scope: args.snapshot.scope,
    userMessage,
    replySummary: args.snapshot.replySummary,
    issueIds: args.snapshot.issueIds,
    shownIssueIds: args.snapshot.shownIssueIds,
    remainingIssueIds: args.snapshot.remainingIssueIds,
    totalItemCount: args.snapshot.totalItemCount,
    referenceItems: args.snapshot.referenceItems,
    recordedAt: args.recordedAt.toISOString(),
  };
}

async function persistQueryContinuationForAction(args: {
  paths: ReturnType<typeof buildThreadPaths>;
  action: "query" | "conversation" | "mutation";
  queryKind?: ThreadQueryKind;
  messageText: string;
  now: Date;
  snapshot?: ThreadQueryContinuationSnapshotInput;
}): Promise<void> {
  if (args.action === "query" && hasCompleteQuerySnapshot(args.snapshot)) {
    const continuation = buildThreadQueryContinuation({
      queryKind: args.queryKind,
      messageText: args.messageText,
      recordedAt: args.now,
      snapshot: args.snapshot,
    });
    if (continuation) {
      await saveThreadQueryContinuation(args.paths, continuation);
    }
    return;
  }

  if (args.action === "mutation") {
    await clearThreadQueryContinuation(args.paths);
  }
}

function mergeAgentReplyWithCommit(args: {
  agentReply: string;
  commitSummaries: string[];
  commitRejections: string[];
}): string {
  const paragraphs: string[] = [];
  const normalizedAgentReply = args.agentReply.trim();
  const visibleCommitSummaries = normalizedAgentReply
    ? args.commitSummaries.filter((summary) => !shouldSuppressCommitSummary(normalizedAgentReply, summary))
    : args.commitSummaries;
  if (normalizedAgentReply) {
    paragraphs.push(normalizedAgentReply);
  }
  if (visibleCommitSummaries.length > 0) {
    if (normalizedAgentReply) {
      paragraphs.push(formatCommitLogs(visibleCommitSummaries));
    } else {
      paragraphs.push(...visibleCommitSummaries);
    }
  }
  const rejectionReply = buildCommitRejectionReply(args.commitRejections);
  if (rejectionReply) {
    paragraphs.push(rejectionReply);
  }
  return composeSlackReply(paragraphs);
}

async function buildConversationReply(
  config: AppConfig,
  message: ManagerSlackMessage,
  now: Date,
  conversationKind: "greeting" | "smalltalk" | "other",
): Promise<string> {
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  await ensureThreadWorkspace(paths);

  try {
    const result = await runManagerReplyTurn(config, paths, {
      kind: "conversation",
      conversationKind,
      currentDate: currentDateInJst(now),
      messageText: message.text,
      facts: {
        messageText: message.text,
        conversationKind,
      },
      taskKey: `${message.channelId}-${message.rootThreadTs}-conversation-reply`,
    });
    return result.reply;
  } catch {
    return buildFallbackConversationReply(conversationKind);
  }
}

function buildSafetyOnlyManagerFallbackReply(
  message: ManagerSlackMessage,
  pendingClarification?: PendingManagerClarification,
): {
  action: ManagerMessageKind;
  reply: string;
} {
  if (pendingClarification && isPendingManagerClarificationStatusQuestion(message.text)) {
    return {
      action: "conversation",
      reply: joinSlackSentences([
        "この thread では、前の依頼を task として確定するための補足待ちです。",
        pendingClarification.missingDecisionSummary ?? "何を task にしたいかをもう一度短く言い換えてもらえれば、その続きとして扱います。",
      ]) ?? "この thread では前の依頼の補足待ちです。",
    };
  }
  if (pendingClarification && isPendingManagerClarificationContinuation(message.text)) {
    return {
      action: pendingClarification.intent === "create_work"
        ? "request"
        : pendingClarification.intent === "update_progress"
          ? "progress"
          : pendingClarification.intent === "update_completed"
            ? "completed"
            : pendingClarification.intent === "update_blocked"
              ? "blocked"
              : "request",
      reply: joinSlackSentences([
        "補足として受け取りました。",
        "この thread の続きとして扱うので、直したい点や更新したい issue を 1 文で言い換えてもらえれば再試行できます。",
      ]) ?? "補足として受け取りました。",
    };
  }

  const action = classifyManagerSignal(message.text);
  if (action === "conversation") {
    return {
      action,
      reply: buildFallbackConversationReply(detectFallbackConversationKind(message.text)),
    };
  }
  if (action === "query") {
    return {
      action,
      reply: buildSafetyQueryReply(),
    };
  }
  if (action === "progress" || action === "completed" || action === "blocked") {
    return {
      action,
      reply: "いまは更新対象を安全に確定できないため、`AIC-123` のように issue ID を添えてもう一度送ってください。",
    };
  }
  return {
    action,
    reply: "いまは起票内容を安全に確定できないため、直したい点を 1 文で言い換えるか、親 issue の有無を補足してください。次の返信はこの thread の続きとして扱います。",
  };
}

async function loadMessageRouterInput(
  config: AppConfig,
  repositories: Pick<ManagerRepositories, "workgraph">,
  message: ManagerSlackMessage,
  now: Date,
  pendingClarification?: Awaited<ReturnType<typeof getPendingClarificationForThread>>,
): Promise<MessageRouterInput> {
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  const recentThread = await getSlackThreadContext(
    config.workspaceDir,
    message.channelId,
    message.rootThreadTs,
    8,
  ).catch(() => undefined);
  const planningContext = await getThreadPlanningContext(
    repositories.workgraph,
    buildWorkgraphThreadKey(message.channelId, message.rootThreadTs),
  ).catch(() => undefined);
  const lastQueryContext = await loadThreadQueryContinuation(paths).catch(() => undefined);

  return {
    channelId: message.channelId,
    rootThreadTs: message.rootThreadTs,
    userId: message.userId,
    messageText: message.text,
    currentDate: currentDateInJst(now),
    recentThreadEntries: (recentThread?.entries ?? [])
      .slice(-6)
      .map((entry) => ({
        role: entry.type,
        text: entry.text,
      })),
    lastQueryContext,
    threadContext: {
      intakeStatus: pendingClarification?.intakeStatus ?? planningContext?.thread.intakeStatus,
      pendingClarification: pendingClarification?.pendingClarification ?? planningContext?.thread.pendingClarification ?? false,
      clarificationQuestion: pendingClarification?.clarificationQuestion ?? planningContext?.thread.clarificationQuestion,
      originalRequestText: pendingClarification?.originalText ?? planningContext?.thread.originalText,
      parentIssueId: planningContext?.thread.parentIssueId,
      childIssueIds: planningContext?.thread.childIssueIds ?? [],
      linkedIssueIds: planningContext?.thread.linkedIssueIds ?? [],
      latestFocusIssueId: planningContext?.thread.latestFocusIssueId,
      lastResolvedIssueId: planningContext?.thread.lastResolvedIssueId,
    },
    taskKey: `${message.channelId}-${message.rootThreadTs}-message-router`,
  };
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
  const asks: string[] = [];

  if (needs.includes("scope")) {
    asks.push("何をどこまで対応するタスクか、対象をもう少し具体化してください。");
  }
  if (needs.includes("due_date")) {
    asks.push("期限を確認したいです。いつまでに完了したいか教えてください。例: 2026-03-20 / 今日中 / 明日");
  }
  if (needs.includes("execution_plan")) {
    asks.push("進め方を固めたいです。完了条件か、分けたい作業を 1-3 点で教えてください。");
  }

  return composeSlackReply([
    joinSlackSentences([
      "起票前に確認したい点があります。",
      `対象は ${title} です。`,
    ]),
    formatSlackBullets(asks),
    "返答をもらえれば、その内容を取り込んで Linear に起票します。",
  ]);
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

function isManagerRepositories(value: unknown): value is ManagerRepositories {
  return typeof value === "object"
    && value !== null
    && "policy" in value
    && "ownerMap" in value
    && "followups" in value
    && "planning" in value
    && "workgraph" in value;
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
      buildReviewFollowup: (item, ownerMap, existingFollowup, issueSources) => buildReviewFollowup(
        item,
        ownerMap,
        existingFollowup,
        issueSources,
        { normalizeText },
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
      buildIssueRiskSummary,
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
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  await ensureThreadWorkspace(paths);
  const threadKey = buildWorkgraphThreadKey(message.channelId, message.rootThreadTs);
  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };

  try {
    const lastQueryContext = await loadThreadQueryContinuation(paths).catch(() => undefined);
    const pendingManagerClarification = await loadPendingManagerClarification(paths, now).catch(() => undefined);
    const threadPlanningContext = await getThreadPlanningContext(repositories.workgraph, threadKey).catch(() => undefined);
    const agentTurn = await runManagerAgentTurn(config, paths, {
      kind: "message",
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
      userId: message.userId,
      text: message.text,
      currentDate: currentDateInJst(now),
      lastQueryContext,
      pendingClarification: pendingManagerClarification,
    });

    if (agentTurn.invalidProposalCount > 0 && agentTurn.proposals.length === 0) {
      throw new Error(`manager agent returned ${agentTurn.invalidProposalCount} invalid proposals`);
    }
    if (pendingManagerClarification && !agentTurn.pendingClarificationDecision) {
      throw new Error("manager agent missing pending clarification decision");
    }

    const commitResult = await commitManagerCommandProposals({
      config,
      repositories,
      proposals: agentTurn.proposals,
      message,
      now,
      policy,
      env,
    });
    const agentIntent = agentTurn.intentReport?.intent;
    const extractedQuerySnapshot = agentIntent === "query"
      ? extractQuerySnapshot(agentTurn.toolCalls)
      : undefined;
    const completeQuerySnapshot = hasCompleteQuerySnapshot(extractedQuerySnapshot)
      ? extractedQuerySnapshot
      : undefined;
    const missingQuerySnapshot = agentIntent === "query" && !completeQuerySnapshot;
    const mergedReply = missingQuerySnapshot
      ? buildSafetyQueryReply()
      : mergeAgentReplyWithCommit({
          agentReply: agentTurn.reply,
          commitSummaries: commitResult.replySummaries,
          commitRejections: commitResult.rejected.map((entry) => entry.reason),
        });

    if (agentIntent === "query") {
      const queryKind = agentTurn.intentReport?.queryKind;
      if (!queryKind) {
        throw new Error("manager agent query missing queryKind");
      }
      if (completeQuerySnapshot) {
        await persistQueryContinuationForAction({
          paths,
          action: "query",
          queryKind,
          messageText: message.text,
          now,
          snapshot: completeQuerySnapshot,
        });
      } else {
        await clearThreadQueryContinuation(paths);
      }
    } else if (
      agentIntent === "create_work"
      || agentIntent === "update_progress"
      || agentIntent === "update_completed"
      || agentIntent === "update_blocked"
      || agentIntent === "followup_resolution"
      || agentIntent === "review"
      || agentIntent === "heartbeat"
      || agentIntent === "scheduler"
    ) {
      await persistQueryContinuationForAction({
        paths,
        action: "mutation",
        messageText: message.text,
        now,
      });
    }

    const pendingPersistence = agentTurn.pendingClarificationDecision?.persistence;
    const commitSucceeded = commitResult.committed.length > 0;
    if (commitSucceeded && pendingManagerClarification) {
      await clearPendingManagerClarification(paths);
    } else if (pendingPersistence === "clear") {
      await clearPendingManagerClarification(paths);
    } else if (pendingPersistence === "replace" && isMutableIntent(agentIntent)) {
      await persistPendingManagerClarification({
        paths,
        intent: agentIntent,
        originalUserMessage: originalMessageForPendingClarification(
          pendingManagerClarification,
          agentTurn.pendingClarificationDecision?.decision,
          message.text,
        ),
        lastUserMessage: message.text,
        clarificationReply: mergedReply,
        missingDecisionSummary: commitResult.rejected.map((entry) => entry.reason).join(" / ")
          || agentTurn.pendingClarificationDecision?.summary,
        threadParentIssueId: threadPlanningContext?.parentIssue?.issueId ?? threadPlanningContext?.thread.parentIssueId,
        relatedIssueIds: unique([
          ...(threadPlanningContext?.childIssues.map((issue) => issue.issueId) ?? []),
          ...(threadPlanningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
          threadPlanningContext?.latestResolvedIssue?.issueId ?? "",
        ].filter(Boolean)),
        now,
      });
    }

    await saveLastManagerAgentTurn(paths, {
      recordedAt: now.toISOString(),
      intent: agentTurn.intentReport?.intent,
      queryKind: agentTurn.intentReport?.queryKind,
      queryScope: agentTurn.intentReport?.queryScope,
      confidence: agentTurn.intentReport?.confidence,
      summary: agentTurn.intentReport?.summary,
      pendingClarificationDecision: agentTurn.pendingClarificationDecision?.decision,
      pendingClarificationPersistence: agentTurn.pendingClarificationDecision?.persistence,
      pendingClarificationDecisionSummary: agentTurn.pendingClarificationDecision?.summary,
      missingQuerySnapshot,
    });

    return {
      handled: true,
      reply: mergedReply,
      diagnostics: {
        agent: {
          source: "agent",
          intent: agentTurn.intentReport?.intent,
          queryKind: agentTurn.intentReport?.queryKind,
          queryScope: agentTurn.intentReport?.queryScope,
          confidence: agentTurn.intentReport?.confidence,
          reasoningSummary: agentTurn.intentReport?.summary,
          toolCalls: agentTurn.toolCalls.map((call) => call.toolName),
          proposalCount: agentTurn.proposals.length,
          invalidProposalCount: agentTurn.invalidProposalCount,
          committedCommands: commitResult.committed.map((entry) => entry.commandType),
          commitRejections: commitResult.rejected.map((entry) => entry.reason),
          pendingClarificationDecision: agentTurn.pendingClarificationDecision?.decision,
          pendingClarificationPersistence: agentTurn.pendingClarificationDecision?.persistence,
          pendingClarificationDecisionSummary: agentTurn.pendingClarificationDecision?.summary,
          missingQuerySnapshot,
        },
      },
    };
  } catch (error) {
    const pendingManagerClarification = await loadPendingManagerClarification(paths, now).catch(() => undefined);
    const threadPlanningContext = await getThreadPlanningContext(repositories.workgraph, threadKey).catch(() => undefined);
    const fallbackPendingDecision = pendingManagerClarification
      ? isPendingManagerClarificationStatusQuestion(message.text)
        ? "status_question"
        : isPendingManagerClarificationContinuation(message.text)
          ? "continue_pending"
          : undefined
      : undefined;
    const safetyFallback = buildSafetyOnlyManagerFallbackReply(message, pendingManagerClarification);
    await saveLastManagerAgentTurn(paths, {
      recordedAt: now.toISOString(),
      pendingClarificationDecision: fallbackPendingDecision,
      pendingClarificationDecisionSummary: error instanceof Error ? error.message : String(error),
      pendingClarificationPersistence: pendingManagerClarification ? "keep" : undefined,
      missingQuerySnapshot: false,
    });
    if (safetyFallback.action !== "conversation") {
      const fallbackIntent = safetyFallback.action === "request"
        ? "create_work"
        : safetyFallback.action === "progress"
          ? "update_progress"
          : safetyFallback.action === "completed"
            ? "update_completed"
            : safetyFallback.action === "blocked"
              ? "update_blocked"
              : undefined;
      if (fallbackIntent) {
        await persistPendingManagerClarification({
          paths,
          intent: fallbackIntent,
          originalUserMessage: originalMessageForPendingClarification(
            pendingManagerClarification,
            fallbackPendingDecision,
            message.text,
          ),
          lastUserMessage: message.text,
          clarificationReply: safetyFallback.reply,
          missingDecisionSummary: error instanceof Error ? error.message : String(error),
          threadParentIssueId: threadPlanningContext?.parentIssue?.issueId ?? threadPlanningContext?.thread.parentIssueId,
          relatedIssueIds: unique([
            ...(threadPlanningContext?.childIssues.map((issue) => issue.issueId) ?? []),
            ...(threadPlanningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
            threadPlanningContext?.latestResolvedIssue?.issueId ?? "",
          ].filter(Boolean)),
          now,
        });
      }
    }
    return {
      handled: true,
      reply: safetyFallback.reply,
      diagnostics: {
        agent: {
          source: "fallback",
          toolCalls: [],
          proposalCount: 0,
          committedCommands: [],
          commitRejections: [],
          pendingClarificationDecision: fallbackPendingDecision,
          pendingClarificationPersistence: pendingManagerClarification ? "keep" : undefined,
          pendingClarificationDecisionSummary: error instanceof Error ? error.message : String(error),
          missingQuerySnapshot: false,
          technicalFailure: error instanceof Error ? error.message : String(error),
        },
        router: {
          source: "fallback",
          action: safetyFallback.action,
          technicalFailure: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

async function handleManagerMessageLegacy(
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
  const followups = await repositories.followups.load();
  const paths = buildThreadPaths(config.workspaceDir, message.channelId, message.rootThreadTs);
  await ensureThreadWorkspace(paths);
  const pendingClarification = await getPendingClarificationForThread(
    repositories.workgraph,
    buildWorkgraphThreadKey(message.channelId, message.rootThreadTs),
  );
  const originalRequestText = pendingClarification?.originalText ?? message.text;
  const followupText = pendingClarification ? message.text : "";
  const combinedRequestText = pendingClarification
    ? `${originalRequestText}\n${followupText}`.trim()
    : message.text;
  const requestMessage: ManagerSlackMessage = pendingClarification
    ? {
        ...message,
        messageTs: pendingClarification.sourceMessageTs ?? message.messageTs,
        text: combinedRequestText,
      }
    : message;
  let routerResult: MessageRouterResult | undefined;
  let routerDiagnostics: ManagerHandleResult["diagnostics"] = undefined;
  const routerInput = await loadMessageRouterInput(config, repositories, message, now, pendingClarification);

  try {
    routerResult = await runMessageRouterTurn(
      config,
      paths,
      routerInput,
    );
    routerDiagnostics = {
      router: {
        source: "llm",
        action: routerResult.action,
        queryKind: routerResult.action === "query" ? routerResult.queryKind : undefined,
        queryScope: routerResult.action === "query" ? routerResult.queryScope : undefined,
        confidence: routerResult.confidence,
        reasoningSummary: routerResult.reasoningSummary,
      },
    };
  } catch (error) {
    const signal = pendingClarification ? "request" : classifyManagerSignal(message.text);
    const queryKind: ManagerQueryKind | undefined = !pendingClarification && signal === "query"
      ? classifyManagerQuery(message.text)
      : undefined;
    routerDiagnostics = {
      router: {
        source: "fallback",
        action: signal,
        queryKind,
        technicalFailure: error instanceof Error ? error.message : String(error),
      },
    };
    if (signal === "query" && queryKind) {
      routerResult = {
        action: "query",
        queryKind,
        queryScope: /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/i.test(message.text) ? "self" : "team",
        confidence: 0,
        reasoningSummary: "LLM router fallback",
      };
    } else if (signal === "progress") {
      routerResult = { action: "update_progress", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else if (signal === "completed") {
      routerResult = { action: "update_completed", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else if (signal === "blocked") {
      routerResult = { action: "update_blocked", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else if (signal === "request") {
      routerResult = { action: "create_work", confidence: 0, reasoningSummary: "LLM router fallback" };
    } else {
      routerResult = {
        action: "conversation",
        conversationKind: detectFallbackConversationKind(message.text),
        confidence: 0,
        reasoningSummary: "LLM router fallback",
      };
    }
  }

  const env = {
    ...process.env,
    LINEAR_API_KEY: config.linearApiKey,
    LINEAR_WORKSPACE: config.linearWorkspace,
    LINEAR_TEAM_KEY: config.linearTeamKey,
  };
  const signal = routerResult.action === "update_progress"
    ? "progress"
    : routerResult.action === "update_completed"
      ? "completed"
      : routerResult.action === "update_blocked"
        ? "blocked"
        : routerResult.action === "create_work"
          ? "request"
          : routerResult.action === "query"
            ? "query"
            : "conversation";

  const updatesResult = await handleManagerUpdates({
    config,
    repositories,
    message,
    now,
    signal,
    policy,
    followups,
    allowFollowupResolution: !pendingClarification,
    env,
    helpers: {
      formatReviewFollowupPrompt,
      assessRisk,
      nowIso,
    },
  });
  if (updatesResult) {
    await persistQueryContinuationForAction({
      paths,
      action: "mutation",
      messageText: message.text,
      now,
    });
    return {
      ...updatesResult,
      diagnostics: routerDiagnostics,
    };
  }

  if (routerResult.action === "query") {
    const result = await handleManagerQuery({
      config,
      repositories,
      kind: routerResult.queryKind,
      queryScope: routerResult.queryScope,
      message,
      now,
      workspaceDir: config.workspaceDir,
      env,
      lastQueryContext: routerInput.lastQueryContext,
    });
    if (result.handled && result.reply) {
      await persistQueryContinuationForAction({
        paths,
        action: "query",
        queryKind: routerResult.queryKind,
        messageText: message.text,
        now,
        snapshot: result.continuation,
      });
    }
    return {
      ...result,
      diagnostics: routerDiagnostics,
    };
  }

  if (routerResult.action === "conversation") {
    return {
      handled: true,
      reply: await buildConversationReply(config, message, now, routerResult.conversationKind),
      diagnostics: routerDiagnostics,
    };
  }

  if (!policy.autoCreate) {
    return { handled: false, diagnostics: routerDiagnostics };
  }

  const intakeResult = await handleIntakeRequest({
    config,
    repositories,
    message,
    now,
    policy,
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
  if (intakeResult.handled) {
    await persistQueryContinuationForAction({
      paths,
      action: "mutation",
      messageText: message.text,
      now,
    });
  }
  return {
    ...intakeResult,
    diagnostics: routerDiagnostics,
  };
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
      buildReviewFollowup: (item, ownerMap, existingFollowup, issueSources) => buildReviewFollowup(
        item,
        ownerMap,
        existingFollowup,
        issueSources,
        { normalizeText },
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
      buildIssueRiskSummary,
      formatRiskLine,
      selectReviewFollowupItem,
    },
  });
}
