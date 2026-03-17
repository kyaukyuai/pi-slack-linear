import type { AppConfig } from "./config.js";
import {
  addLinearComment,
  addLinearRelation,
  assignLinearIssue,
  createManagedLinearIssue,
  listRiskyLinearIssues,
  searchLinearIssues,
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
import type { SystemPaths } from "./system-workspace.js";

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
  const bulletLines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^(\s*[-*・•]|\s*\d+[.)])\s*/.test(line))
    .map((line) => line.replace(/^[-*・\d.)\s]+/, "").trim())
    .filter(Boolean);

  if (bulletLines.length >= 2) {
    return Array.from(new Set(bulletLines));
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
  title = title.replace(/^[-*・•\d.)\s]+/, "");
  title = title.replace(/(の)?(タスク|issue|Issue|イシュー|ticket|チケット)(を)?/g, " ");
  title = title.replace(/(しておいて|やっておいて|追加して|作成して|作って|登録して|おいて|お願い(します)?|対応して|進めておいて|進めて)/g, " ");
  title = title.replace(/[。！!？?]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/を$/, "");
  return title || "Slack からの依頼";
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

function formatAutonomousCreateReply(parent: LinearIssue | undefined, children: LinearIssue[], reason: string, usedFallback: boolean): string {
  const lines = ["Linear に自律起票しました。", `- 理由: ${reason}`];
  if (parent) {
    lines.push(`- 親issue: ${parent.identifier} ${parent.title}`);
  }
  if (children.length > 0) {
    lines.push(`- 子issue数: ${children.length}`);
    for (const child of children) {
      lines.push(formatIssueLine(child));
    }
  }
  if (!parent && children.length === 1) {
    lines.push(`- Issue: ${children[0].identifier} ${children[0].title}`);
  }
  if (usedFallback) {
    lines.push("- 担当未定義のため暫定で kyaukyuai に寄せています。");
  }
  const primary = parent ?? children[0];
  if (primary?.url) {
    lines.push(`- URL: ${primary.url}`);
  }
  return lines.join("\n");
}

function formatExistingIssueReply(duplicates: LinearIssue[]): string {
  const lines = ["既存の Linear issue が見つかったため、新規起票は行いませんでした。"];
  for (const issue of duplicates.slice(0, 3)) {
    lines.push(formatIssueLine(issue));
    if (issue.url) {
      lines.push(`  ${issue.url}`);
    }
  }
  return lines.join("\n");
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
  const blocked =
    issue.state?.name?.toLowerCase().includes("block") === true ||
    issue.state?.type?.toLowerCase().includes("block") === true ||
    (issue.relations?.length ?? 0) > 0 ||
    (issue.inverseRelations?.length ?? 0) > 0;
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
  if (!policy.autoCreate) {
    return { handled: false };
  }

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
  if (signal !== "request") {
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

  const duplicates = await searchLinearIssues(
    {
      query: primaryTitle.slice(0, 32),
      limit: 5,
    },
    env,
  );

  if (duplicates.length > 0) {
    const nextLedger = [
      ...intakeLedger.filter((entry) => entry !== pendingClarification),
      {
        sourceChannelId: requestMessage.channelId,
        sourceThreadTs: requestMessage.rootThreadTs,
        sourceMessageTs: pendingClarification?.sourceMessageTs ?? requestMessage.messageTs,
        messageFingerprint: fingerprint,
        childIssueIds: duplicates.map((issue) => issue.identifier),
        status: "linked-existing",
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

  const dueDate = extractDueDate(requestMessage.text, now);
  const segmentsFromFollowup = pendingClarification ? extractTaskSegments(followupText) : [];
  const segments = segmentsFromFollowup.length > 0 ? segmentsFromFollowup : extractTaskSegments(requestMessage.text);
  const complex = isComplexRequest(originalRequestText) || segments.length >= 2;
  const research = needsResearchTask(originalRequestText);
  const usedFallbackOwners = new Set<string>();

  const parent = complex || research
    ? await createManagedLinearIssue(
        {
          title: primaryTitle,
          description: [
            "## 目的",
            primaryTitle,
            "",
            "## 完了条件",
            "- Slack の依頼を親 issue として管理する",
            "- 実行子 issue で前進できる状態にする",
          ].join("\n"),
          dueDate,
          priority: dueDate ? 2 : undefined,
        },
        env,
      )
    : undefined;

  const createdChildren: LinearIssue[] = [];
  const planningReason = research ? "research-first" : complex ? "complex-request" : "single-issue";
  const rawChildren = segments.length > 0
    ? segments
    : research
      ? [`調査: ${primaryTitle}`]
      : complex
        ? [`実行: ${primaryTitle}`]
        : [primaryTitle];

  for (const childText of rawChildren) {
    const childTitle = deriveIssueTitle(childText);
    const owner = chooseOwner(childTitle, ownerMap);
    if (owner.resolution === "fallback") {
      usedFallbackOwners.add(owner.entry.id);
    }

    const child = await createManagedLinearIssue(
      {
        title: childTitle,
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
        dueDate,
        parent: parent?.identifier,
        assignee: owner.entry.linearAssignee,
        priority: dueDate ? 2 : undefined,
      },
      env,
    );

    createdChildren.push(child);
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

  const ownerAssignments = parent ? [parent, ...createdChildren] : createdChildren;
  for (const issue of ownerAssignments) {
    const owner = chooseOwner(issue.title, ownerMap);
    await assignLinearIssue(issue.identifier, owner.entry.linearAssignee, env);
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
    reply: formatAutonomousCreateReply(parent, createdChildren, planningReason, usedFallbackOwners.size > 0),
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
    return lines.join("\n");
  }

  const fallbackCount = planningLedger.filter((entry) => entry.ownerResolution === "fallback").length;
  const intakeCount = intakeLedger.filter((entry) => entry.status !== "created").length;
  const staleItems = sorted.filter((item) => item.riskCategories.includes("stale")).slice(0, 5);
  const lines = ["週次 planning review です。"];
  lines.push(`- 未整備 issue: ${sorted.filter((item) => item.ownerMissing || item.dueMissing).length}`);
  lines.push(`- 長期 stale: ${staleItems.length}`);
  lines.push(`- owner map gap: ${fallbackCount}`);
  lines.push(`- 新規依頼の取り込み漏れ候補: ${intakeCount}`);
  for (const item of staleItems) {
    lines.push(formatRiskLine(item));
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
