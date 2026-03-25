import type { ManagerPolicy } from "../../state/manager-state-contract.js";
import { buildSlackTargetLabel, composeSlackReply, formatSlackBullets, joinSlackSentences } from "../shared/slack-conversation.js";
import type { QueryContinuationSnapshot, RankedQueryItem, ViewerQueryOptions } from "./query-contract.js";
import { isTodayCandidate, preferViewerOwnedItems } from "./query-ranking.js";
import { formatRiskReasons, mapRankedItemFacts } from "./query-support.js";

export function formatQueryIssueLine(item: RankedQueryItem): string {
  const assignee = item.issue.assignee?.displayName ?? item.issue.assignee?.name ?? "未割当";
  const due = item.issue.dueDate ?? "未設定";
  const state = item.issue.state?.name;
  const priority = item.issue.priorityLabel;
  const cycle = item.issue.cycle?.name ?? (item.issue.cycle?.number != null ? String(item.issue.cycle.number) : undefined);
  const reason = formatRiskReasons(item.assessment.riskCategories);

  return joinSlackSentences([
    `${buildSlackTargetLabel(item.issue)}。`,
    `担当は ${assignee} です。`,
    `期限は ${due} です。`,
    state ? `状態は ${state} です。` : undefined,
    priority ? `優先度は ${priority} です。` : undefined,
    cycle ? `Cycle は ${cycle} です。` : undefined,
    reason ? `今見ておきたい理由は ${reason} です。` : "現時点では大きなリスクは強く出ていません。",
  ]) ?? buildSlackTargetLabel(item.issue);
}

export function buildQueryContinuationSnapshot(
  visibleItems: RankedQueryItem[],
  unique: <T>(values: T[]) => T[],
  options: {
    shownIssueIds?: string[];
    remainingIssueIds?: string[];
    totalItemCount?: number;
  } = {},
): QueryContinuationSnapshot {
  const issueIds = visibleItems.map((item) => item.issue.identifier);
  const shownIssueIds = unique(options.shownIssueIds ?? issueIds);
  const remainingIssueIds = unique(options.remainingIssueIds ?? []);
  const totalItemCount = options.totalItemCount ?? Math.max(issueIds.length, shownIssueIds.length + remainingIssueIds.length);
  return {
    issueIds,
    shownIssueIds,
    remainingIssueIds,
    totalItemCount,
  };
}

function buildContinuationItemLine(item: RankedQueryItem): string {
  const reason = formatRiskReasons(item.assessment.riskCategories);
  return joinSlackSentences([
    `${buildSlackTargetLabel(item.issue)}。`,
    reason ? `気になっている点は ${reason} です。` : undefined,
  ]) ?? buildSlackTargetLabel(item.issue);
}

export function buildListContinuationReply(
  visibleItems: RankedQueryItem[],
  snapshot: QueryContinuationSnapshot,
): string {
  if (visibleItems.length === 0) {
    if (snapshot.shownIssueIds.length === 0) {
      return "ほかに動いている task は今のところありません。";
    }
    if (snapshot.shownIssueIds.length === 1) {
      return `ほかに動いている task は今のところありません。見ておくべきものは ${snapshot.shownIssueIds[0]} だけです。`;
    }
    return `ほかに動いている task は今のところありません。いま見えているのは ${snapshot.shownIssueIds.join("、")} です。`;
  }

  if (visibleItems.length === 1) {
    return composeSlackReply([
      `ほかに見ておくなら ${buildSlackTargetLabel(visibleItems[0].issue)} があります。`,
      buildContinuationItemLine(visibleItems[0]),
      snapshot.remainingIssueIds.length > 0 ? `このあとにまだ ${snapshot.remainingIssueIds.length} 件あります。` : undefined,
    ]);
  }

  return composeSlackReply([
    `ほかに見ておく task は次の ${visibleItems.length} 件です。`,
    formatSlackBullets(visibleItems.map((item) => buildContinuationItemLine(item))),
    snapshot.remainingIssueIds.length > 0 ? `このあとにまだ ${snapshot.remainingIssueIds.length} 件あります。` : undefined,
  ]);
}

export function buildViewerMappingNotice(viewerMappingMissing: boolean | undefined): string | undefined {
  if (!viewerMappingMissing) return undefined;
  return "Slack user と担当者の対応付けがまだ無いので、いったんチーム全体から候補を出しています。ownerMap.slackUserId を入れると自分向けに寄せられます。";
}

export function buildListActiveReply(items: RankedQueryItem[]): string {
  if (items.length === 0) {
    return composeSlackReply([
      "いま active な task は見当たりません。",
      "新しく進めたい依頼があれば、そのままこの channel で送ってください。",
    ]);
  }

  const visible = items.slice(0, 6);
  const overflow = items.length > visible.length
    ? `全体では ${items.length} 件あり、ここでは優先して見やすいものを ${visible.length} 件だけ出しています。`
    : `いま動いている task は ${items.length} 件です。`;

  return composeSlackReply([
    joinSlackSentences([
      "タスク一覧を確認しました。",
      overflow,
    ]),
    formatSlackBullets(visible.map((item) => formatQueryIssueLine(item))),
    "気になる issue があれば、issue ID を返してもらえれば詳細も追えます。",
  ]);
}

export function selectVisibleItemsByIssueIds(
  items: RankedQueryItem[],
  orderedIssueIds: string[],
  limit: number,
): RankedQueryItem[] {
  const issueMap = new Map(items.map((item) => [item.issue.identifier, item] as const));
  return orderedIssueIds
    .map((issueId) => issueMap.get(issueId))
    .filter((item): item is RankedQueryItem => item !== undefined)
    .slice(0, limit);
}

export function buildListTodayReply(
  items: RankedQueryItem[],
  policy: ManagerPolicy,
  options?: ViewerQueryOptions,
): string {
  const scopedItems = options?.preferViewerOwned ? preferViewerOwnedItems(items, options.viewerAssignee) : items;
  const todayItems = scopedItems.filter((item) => isTodayCandidate(item, policy));
  const visible = (todayItems.length > 0 ? todayItems : scopedItems).slice(0, 5);
  const intro = todayItems.length > 0
    ? options?.preferViewerOwned && options.viewerAssignee && visible.every((item) => item.viewerOwned)
      ? `${options.viewerDisplayLabel ?? "担当中のもの"} を基準に、今日優先して見たい task を整理しました。`
      : "今日優先して見たい task を整理しました。"
    : options?.preferViewerOwned && options.viewerAssignee
      ? `${options.viewerDisplayLabel ?? "担当中のもの"} では期限や blocked が強い task は多くありません。手を付けるなら次の順がよさそうです。`
      : "今日は期限や blocked で強く急ぐ task は多くありません。手を付けるなら次の順がよさそうです。";

  if (visible.length === 0) {
    return composeSlackReply([
      "今日は優先して動くべき active task は見当たりません。",
      "新しい依頼があれば、そのままこの channel で送ってください。",
    ]);
  }

  return composeSlackReply([
    intro,
    formatSlackBullets(visible.map((item) => formatQueryIssueLine(item))),
    buildViewerMappingNotice(options?.viewerMappingMissing),
    "進めるものが決まったら、その issue ID か thread で進捗を返してください。",
  ]);
}

export function buildWhatShouldIDoReply(
  items: RankedQueryItem[],
  policy: ManagerPolicy,
  today: string,
  options?: ViewerQueryOptions,
): string {
  if (items.length === 0) {
    return composeSlackReply([
      "いま着手中の task は見当たりません。",
      "新しく進めたい依頼があれば、そのまま送ってください。",
    ]);
  }

  const scopedItems = options?.preferViewerOwned ? preferViewerOwnedItems(items, options.viewerAssignee) : items;
  const todayItems = scopedItems.filter((item) => isTodayCandidate(item, policy));
  const visible = (todayItems.length > 0 ? todayItems : scopedItems).slice(0, 3);
  const top = visible[0];
  const topLabel = top ? buildSlackTargetLabel(top.issue) : undefined;
  const intro = todayItems.length > 0
    ? joinSlackSentences([
        options?.preferViewerOwned && options.viewerAssignee && top?.viewerOwned
          ? `${today} 時点で、${options.viewerDisplayLabel ?? "担当中のもの"}の中では ${topLabel} から見るのがよさそうです。`
          : `${today} 時点で、今日まず手を付けるなら ${topLabel} から見るのがよさそうです。`,
        "続けて次の候補も挙げます。",
      ])
    : joinSlackSentences([
        options?.preferViewerOwned && options.viewerAssignee
          ? `${today} 時点では ${options.viewerDisplayLabel ?? "担当中のもの"}で期限や blocked が強く急ぐものは多くありません。`
          : `${today} 時点では期限や blocked で強く急ぐものは多くありません。`,
        `手を付けるなら ${topLabel} から見るのがよさそうです。`,
      ]);

  return composeSlackReply([
    intro,
    formatSlackBullets(visible.map((item) => formatQueryIssueLine(item))),
    options?.viewerMappingMissing
      ? "Slack user と担当者の対応付けがまだ無いので、いったんチーム全体から候補を出しています。ownerMap.slackUserId を入れると自分向けに寄せられます。"
      : undefined,
    "必要なら、このまま優先順位を一緒に絞ります。",
  ]);
}

export { mapRankedItemFacts };
