import type { ThreadQueryContinuation } from "../../lib/query-continuation.js";
import type { ManagerQueryKind, ManagerQueryScope } from "./query-contract.js";

const WHAT_SHOULD_I_DO_PATTERN =
  /(?:(?:今日|本日).*(?:やるべき|やること|優先|どれから|何(?:を|から)?(?:すれば|やれば|したら|進めれば))|what should i do)/i;
const LIST_TODAY_PATTERN =
  /(?:今日|本日).*(?:タスク|todo|issue|イシュー|チケット|一覧|確認|見せ|教えて|見たい|チェック|list)/i;
const LIST_ACTIVE_PATTERN =
  /(?:(?:タスク|todo|issue|イシュー|チケット).*(?:一覧|確認|見せ|教えて|見たい|チェック|list)|(?:進行中|稼働中|active).*(?:タスク|todo|issue|イシュー|チケット)?|(?:他|ほか)には.*(?:タスク|todo|issue|イシュー|チケット).*(?:ある|あります|残ってる|残っています)|(?:どのような|どんな).*(?:タスク|todo|issue|イシュー|チケット).*(?:ある|あります|残ってる|残っています))/i;
const RECOMMEND_NEXT_STEP_PATTERN =
  /(?:(?:\b[A-Z][A-Z0-9]+-\d+\b|この件|その件|このタスク|そのタスク|このissue|そのissue|このイシュー|そのイシュー).*(?:次(?:どう|に)?進める|次(?:何|なに)(?:を|から)?(?:する|すれば|したら)|次アクション|次の一手|どう進めれば|next step)|(?:次(?:どう|に)?進める|次(?:何|なに)(?:を|から)?(?:する|すれば|したら)|次アクション|次の一手|what(?:'s| is) next|next step))/i;
const INSPECT_WORK_PATTERN =
  /(?:(?:\b[A-Z][A-Z0-9]+-\d+\b|この件|その件|このタスク|そのタスク|このissue|そのissue|このイシュー|そのイシュー).*(?:状況|状態|進捗|詳細|どうなってる|どうなっています|どこまで|止まってる|止まっている|見せて|教えて|知りたい|確認したい)|(?:状況|状態|進捗|詳細|どこまで|どうなってる|止まってる).*(?:教えて|見せて|知りたい|確認したい|[?？]))/i;
const SEARCH_EXISTING_PATTERN =
  /(?:(?:既存|同じ|似た|重複).*(?:issue|イシュー|task|タスク|チケット).*(?:ある|あります|あったっけ|探して|検索|確認)|(?:issue|イシュー|task|タスク|チケット).*(?:既存|同じ|似た|重複).*(?:ある|あります|あったっけ|探して|検索|確認)|(?:既に|すでに).*(?:登録|起票).*(?:されてる|されている|ある|あります))/i;
const TASK_BREAKDOWN_LINE_PATTERN = /^\s*(?:[-*・•]\s+|\d+[.)]\s+)/;
const SELF_WORK_PATTERN = /(?:自分|自分の|私|私の|僕|僕の|わたし|わたしの)/i;
const QUERY_CONTINUATION_PATTERN = /(?:他には|ほかには|残りは|残りの|次の候補|ほかの候補|他の候補|続きは)/i;

export function classifyManagerQuery(text: string): ManagerQueryKind | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const taskBreakdownLineCount = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => TASK_BREAKDOWN_LINE_PATTERN.test(line))
    .length;
  if (taskBreakdownLineCount >= 2) return undefined;
  if (SEARCH_EXISTING_PATTERN.test(normalized)) return "search-existing";
  if (RECOMMEND_NEXT_STEP_PATTERN.test(normalized)) return "recommend-next-step";
  if (INSPECT_WORK_PATTERN.test(normalized)) return "inspect-work";
  if (WHAT_SHOULD_I_DO_PATTERN.test(normalized)) return "what-should-i-do";
  if (LIST_TODAY_PATTERN.test(normalized)) return "list-today";
  if (LIST_ACTIVE_PATTERN.test(normalized)) return "list-active";
  return undefined;
}

export function shouldPreferViewerOwned(
  kind: ManagerQueryKind,
  queryScope: ManagerQueryScope,
  text: string,
  viewerAssignee: string | undefined,
): boolean {
  if (!viewerAssignee) return false;
  if (queryScope === "self") return true;
  if (SELF_WORK_PATTERN.test(text)) return true;
  return kind === "what-should-i-do" || kind === "list-today";
}

export function isListContinuationRequest(
  kind: ManagerQueryKind,
  queryScope: ManagerQueryScope,
  text: string,
  lastQueryContext: ThreadQueryContinuation | undefined,
): boolean {
  if (kind !== "list-active" || queryScope !== "thread-context") return false;
  if (!lastQueryContext) return false;
  if (!QUERY_CONTINUATION_PATTERN.test(text)) return false;
  return lastQueryContext.kind === "list-active"
    || lastQueryContext.kind === "list-today"
    || lastQueryContext.kind === "what-should-i-do";
}
