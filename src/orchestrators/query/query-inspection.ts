import { getLatestIssueSource } from "../../state/workgraph/queries.js";
import type { WorkgraphIssueContext, WorkgraphThreadPlanningContext } from "../../state/workgraph/queries.js";
import { getSlackThreadContext } from "../../lib/slack-context.js";
import { buildWorkgraphThreadKey } from "../../state/workgraph/events.js";
import { composeSlackReply, formatSlackBullets, joinSlackSentences, buildSlackTargetLabel } from "../shared/slack-conversation.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { LinearIssue } from "../../lib/linear.js";
import type { RiskAssessment } from "../review/contract.js";
import type { InspectCandidateScore, InspectResolution, QueryMessage } from "./query-contract.js";
import { formatRiskReasons, normalizeComparableText } from "./query-support.js";

export function extractIssueIdentifiers(text: string): string[] {
  return Array.from(new Set(
    Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
      .map((match) => match[1] ?? "")
      .filter(Boolean),
  ));
}

function threadPlanningCandidates(
  planningContext: WorkgraphThreadPlanningContext | undefined,
): Array<{ issueId: string; title?: string; url?: string | null }> {
  if (!planningContext) return [];

  return Array.from(new Set([
    planningContext.thread.latestFocusIssueId,
    planningContext.thread.lastResolvedIssueId,
    planningContext.parentIssue?.issueId,
    ...planningContext.childIssues.map((issue) => issue.issueId),
    ...planningContext.linkedIssues.map((issue) => issue.issueId),
  ].filter(Boolean) as string[])).map((issueId) => {
    const issue = [
      planningContext.parentIssue,
      ...planningContext.childIssues,
      ...planningContext.linkedIssues,
      planningContext.latestResolvedIssue,
    ].find((candidate) => candidate?.issueId === issueId);

    return {
      issueId,
      title: issue?.title,
      url: undefined,
    };
  });
}

function matchIssueMentionScore(
  sourceText: string,
  candidate: { issueId: string; title?: string },
): number {
  const normalizedSource = normalizeComparableText(sourceText);
  if (!normalizedSource) return 0;

  let score = 0;
  if (normalizedSource.includes(candidate.issueId.toLowerCase())) {
    score += 40;
  }

  const normalizedTitle = normalizeComparableText(candidate.title);
  if (normalizedTitle.length >= 2) {
    if (normalizedSource.includes(normalizedTitle)) {
      score += 28;
    } else if (normalizedTitle.includes(normalizedSource) && normalizedSource.length >= 2) {
      score += 8;
    }
  }

  return score;
}

async function scoreInspectCandidates(args: {
  workspaceDir: string;
  message: QueryMessage;
  planningContext: WorkgraphThreadPlanningContext | undefined;
  candidates: Array<{ issueId: string; title?: string; url?: string | null }>;
}): Promise<InspectCandidateScore[]> {
  const recentContext = await getSlackThreadContext(
    args.workspaceDir,
    args.message.channelId,
    args.message.rootThreadTs,
    12,
  ).catch(() => undefined);

  const recentEntries = recentContext?.entries.slice(-6) ?? [];

  return args.candidates.map((candidate) => {
    let score = matchIssueMentionScore(args.message.text, candidate);
    if (args.planningContext?.thread.latestFocusIssueId === candidate.issueId) {
      score += 70;
    }
    if (args.planningContext?.thread.lastResolvedIssueId === candidate.issueId) {
      score += 45;
    }

    recentEntries.forEach((entry, index) => {
      const recencyWeight = recentEntries.length - index;
      score += matchIssueMentionScore(entry.text, candidate) * recencyWeight;
    });

    return {
      ...candidate,
      score,
    };
  });
}

export async function resolveInspectIssue(
  repository: Pick<ManagerRepositories, "workgraph">["workgraph"],
  workspaceDir: string,
  message: QueryMessage,
): Promise<InspectResolution> {
  const explicitIssueIds = extractIssueIdentifiers(message.text);
  if (explicitIssueIds.length === 1) {
    return {
      issueId: explicitIssueIds[0],
      candidates: explicitIssueIds.map((issueId) => ({ issueId })),
    };
  }
  if (explicitIssueIds.length > 1) {
    return {
      candidates: explicitIssueIds.map((issueId) => ({ issueId })),
    };
  }

  const { getThreadPlanningContext } = await import("../../state/workgraph/queries.js");
  const planningContext = await getThreadPlanningContext(
    repository,
    buildWorkgraphThreadKey(message.channelId, message.rootThreadTs),
  );
  const candidates = threadPlanningCandidates(planningContext);

  if (candidates.length === 1) {
    return {
      issueId: candidates[0]?.issueId,
      candidates,
    };
  }
  if (candidates.length >= 2) {
    const scored = await scoreInspectCandidates({
      workspaceDir,
      message,
      planningContext,
      candidates,
    });
    scored.sort((left, right) => right.score - left.score);
    const top = scored[0];
    const second = scored[1];
    if (top && top.score >= 70 && top.score - (second?.score ?? 0) >= 20) {
      return {
        issueId: top.issueId,
        candidates,
      };
    }
  }

  if (planningContext?.thread.latestFocusIssueId) {
    return {
      issueId: planningContext.thread.latestFocusIssueId,
      candidates,
    };
  }
  if (planningContext?.thread.lastResolvedIssueId) {
    return {
      issueId: planningContext.thread.lastResolvedIssueId,
      candidates,
    };
  }

  return { candidates };
}

export function buildInspectSelectionReply(candidates: Array<{ issueId: string; title?: string; url?: string | null }>): string {
  if (candidates.length === 0) {
    return composeSlackReply([
      "どの issue の状況を見るべきか、まだ決めきれていません。",
      "issue ID か task 名をもう少し具体的に教えてください。",
    ]);
  }

  return composeSlackReply([
    "見たい issue が複数ありそうなので、対象を絞りたいです。",
    formatSlackBullets(
      candidates.map((candidate) => (
        candidate.title
          ? `${candidate.issueId} ${candidate.title}`
          : candidate.issueId
      )),
    ),
    "見たい issue ID を返してもらえれば、その状況をすぐ確認します。",
  ]);
}

function summarizeSlackSnippet(text: string, maxLength = 72): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
}

export function formatRecentThreadSummary(
  context: Awaited<ReturnType<typeof getSlackThreadContext>> | undefined,
): string | undefined {
  const entries = context?.entries
    .filter((entry) => typeof entry.text === "string" && entry.text.trim().length > 0)
    .slice(-4) ?? [];
  if (entries.length === 0) return undefined;

  const latestUser = [...entries].reverse().find((entry) => entry.type === "user");
  const latestAssistant = [...entries].reverse().find((entry) => entry.type === "assistant");

  return joinSlackSentences([
    latestUser ? `直近の共有では「${summarizeSlackSnippet(latestUser.text)}」まで見えています。` : undefined,
    latestAssistant ? `直近の案内では「${summarizeSlackSnippet(latestAssistant.text)}」と伝えています。` : undefined,
  ]);
}

function formatIssueHealthSummary(issue: LinearIssue, assessment: RiskAssessment): string | undefined {
  const reasons = formatRiskReasons(assessment.riskCategories);
  if (!reasons) {
    return "直近で強いリスクは見えていません。";
  }
  return `今気になっている点は ${reasons} です。`;
}

export function formatIssueContextReply(args: {
  issue: LinearIssue;
  workgraphIssue?: WorkgraphIssueContext;
  assessment: RiskAssessment;
  sourceThread?: Awaited<ReturnType<typeof getLatestIssueSource>>;
}): string {
  const assignee = args.issue.assignee?.displayName ?? args.issue.assignee?.name ?? args.workgraphIssue?.assignee ?? "未割当";
  const state = args.issue.state?.name ?? "未設定";
  const due = args.issue.dueDate ?? args.workgraphIssue?.dueDate ?? "未設定";
  const priority = args.issue.priorityLabel;
  const cycle = args.issue.cycle?.name ?? (args.issue.cycle?.number != null ? String(args.issue.cycle.number) : undefined);
  const parent = args.issue.parent;
  const children = args.issue.children ?? [];
  const latestThreadStatus = args.workgraphIssue?.lastStatus;
  const followupStatus = args.workgraphIssue?.followupStatus;

  return composeSlackReply([
    joinSlackSentences([
      `${buildSlackTargetLabel(args.issue)} の状況を確認しました。`,
      `担当は ${assignee} です。`,
      `状態は ${state} です。`,
      `期限は ${due} です。`,
      priority ? `優先度は ${priority} です。` : undefined,
      cycle ? `Cycle は ${cycle} です。` : undefined,
    ]),
    joinSlackSentences([
      formatIssueHealthSummary(args.issue, args.assessment),
      latestThreadStatus ? `thread 上で最後に見えている更新は ${latestThreadStatus} です。` : undefined,
      followupStatus === "awaiting-response"
        ? "いまは follow-up の返答待ちです。"
        : followupStatus === "resolved"
          ? "follow-up はいったん解消しています。"
          : undefined,
    ]),
    joinSlackSentences([
      parent ? `親 issue は ${buildSlackTargetLabel(parent)} です。` : undefined,
      children.length > 0 ? `子 issue は ${children.slice(0, 3).map((child) => buildSlackTargetLabel(child)).join("、")} です。` : undefined,
    ]),
    args.sourceThread
      ? `元の thread は channel ${args.sourceThread.channelId} / thread ${args.sourceThread.rootThreadTs} です。`
      : undefined,
  ]);
}

function buildFollowupReplyGuidance(category: string | undefined): string {
  switch (category) {
    case "blocked-details":
      return "いまは follow-up の返答待ちなので、次は blocked の原因、待ち先、再開条件を thread で返してください。";
    case "owner":
      return "いまは follow-up の返答待ちなので、次は誰が担当するかを thread で返してください。";
    case "due-date":
      return "いまは follow-up の返答待ちなので、次はいつまでに完了見込みかを thread で返してください。";
    default:
      return "いまは follow-up の返答待ちなので、次は現在の進捗と次に動く内容を thread で返してください。";
  }
}

export function buildGenericNextStep(args: {
  issue: LinearIssue;
  workgraphIssue?: WorkgraphIssueContext;
  assessment: RiskAssessment;
}): string {
  const categories = new Set(args.assessment.riskCategories);
  const stateType = args.issue.state?.type ?? undefined;
  const firstChild = args.issue.children?.[0];

  if (stateType === "completed" || args.workgraphIssue?.lastStatus === "completed") {
    return "完了として見えているので、次は関連する残件がないかだけ確認すれば十分です。";
  }

  if (args.workgraphIssue?.followupStatus === "awaiting-response") {
    return buildFollowupReplyGuidance(args.workgraphIssue.lastFollowupCategory);
  }

  if (categories.has("blocked") || args.workgraphIssue?.lastStatus === "blocked") {
    return "blocked が見えているので、次は原因、待ち先、再開条件を共有して再開条件をはっきりさせるのが先です。";
  }

  if (categories.has("overdue") || categories.has("due_today")) {
    return "期限が近いので、次は今日中に終える最小ステップを決めて、その進捗をこの thread に返すのがよさそうです。";
  }

  if ((stateType === "unstarted" || stateType === "backlog") && firstChild) {
    return `${buildSlackTargetLabel(firstChild)} から着手するのが進めやすそうです。着手したら、そのままこの thread に進捗を返してください。`;
  }

  if (stateType === "unstarted" || stateType === "backlog") {
    return "未着手に近い状態なので、次は最初の具体作業に着手して、その内容をこの thread に返すのがよさそうです。";
  }

  if (firstChild) {
    return `次は ${buildSlackTargetLabel(firstChild)} の状態を確認して、進んでいなければそこから動くのがよさそうです。`;
  }

  return "次は今の進捗を 1 行で返すか、詰まりがあるなら blocked として理由を共有するのがよさそうです。";
}

export function formatNextStepReply(args: {
  issue: LinearIssue;
  workgraphIssue?: WorkgraphIssueContext;
  assessment: RiskAssessment;
  sourceThread?: Awaited<ReturnType<typeof getLatestIssueSource>>;
  recentThreadSummary?: string;
}): string {
  const assignee = args.issue.assignee?.displayName ?? args.issue.assignee?.name ?? args.workgraphIssue?.assignee ?? "未割当";
  const state = args.issue.state?.name ?? "未設定";
  const due = args.issue.dueDate ?? args.workgraphIssue?.dueDate ?? "未設定";

  return composeSlackReply([
    joinSlackSentences([
      `${buildSlackTargetLabel(args.issue)} について、次の一手を整理しました。`,
      `担当は ${assignee} です。`,
      `状態は ${state} です。`,
      `期限は ${due} です。`,
    ]),
    args.recentThreadSummary,
    buildGenericNextStep(args),
    args.sourceThread
      ? `元の thread は channel ${args.sourceThread.channelId} / thread ${args.sourceThread.rootThreadTs} です。`
      : undefined,
  ]);
}

function stripSearchIntentWords(text: string): string {
  return text
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ")
    .replace(/(?:既存|同じ|似た|重複|過去|前に|以前|すでに|既に)/g, " ")
    .replace(/(?:issue|イシュー|task|タスク|チケット|ticket|todo)/gi, " ")
    .replace(/(?:ある|あります|あったっけ|ありますか|探して|検索して|検索|確認して|確認したい|見せて|教えて|知りたい|ないか|残ってる)/g, " ")
    .replace(/[?？。！!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveSearchQuery(
  text: string,
  planningContext: WorkgraphThreadPlanningContext | undefined,
): string | undefined {
  const stripped = stripSearchIntentWords(text);
  if (stripped.length >= 2) {
    return stripped;
  }

  return planningContext?.latestResolvedIssue?.title
    ?? planningContext?.parentIssue?.title
    ?? planningContext?.childIssues[0]?.title
    ?? planningContext?.linkedIssues[0]?.title
    ?? planningContext?.thread.originalText;
}

export function buildSearchExistingReply(query: string, issues: LinearIssue[]): string {
  if (issues.length === 0) {
    return composeSlackReply([
      `「${query}」で既存 issue を探しましたが、近いものはまだ見当たりませんでした。`,
      "必要ならこのまま新規 task として登録できます。",
    ]);
  }

  if (issues.length === 1) {
    return composeSlackReply([
      `「${query}」で探したところ、近い既存 issue が見つかりました。`,
      `対象は ${buildSlackTargetLabel(issues[0])} です。`,
      "新規起票せずに寄せるなら、この issue を使うのがよさそうです。",
    ]);
  }

  return composeSlackReply([
    `「${query}」で探したところ、近い既存 issue が複数見つかりました。`,
    formatSlackBullets(
      issues.slice(0, 5).map((issue) => (
        joinSlackSentences([
          `${buildSlackTargetLabel(issue)}。`,
          issue.state?.name ? `状態は ${issue.state.name} です。` : undefined,
          issue.assignee?.displayName ?? issue.assignee?.name ? `担当は ${issue.assignee?.displayName ?? issue.assignee?.name} です。` : undefined,
          issue.dueDate ? `期限は ${issue.dueDate} です。` : undefined,
        ]) ?? buildSlackTargetLabel(issue)
      )),
    ),
    "寄せたいものがあれば issue ID を返してください。新規に切るなら、そのまま task 追加の依頼を送ってもらえれば進めます。",
  ]);
}
