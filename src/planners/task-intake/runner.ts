import type { TaskPlanningInput, TaskPlanningResult } from "./contract.js";
import { parseTaskPlanningReply } from "./parser.js";
import { buildTaskPlanningPrompt } from "./prompt.js";

export type TaskPlanningReplyExecutor = (
  prompt: string,
  systemPrompt: string,
  sessionSuffix: string,
) => Promise<string>;

const TASK_PLANNING_SYSTEM_PROMPT = [
  "You are a task intake planner for a Slack-first execution manager.",
  "Reply with valid JSON only.",
  "Convert ambiguous or status-like request text into clean Linear issue titles.",
  "Prefer concise, execution-ready task titles in Japanese.",
  "When enough detail exists, do not ask a clarification question.",
].join("\n");

function normalizePlanningTitle(title: string | undefined): string {
  return (title ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

function postValidateTaskPlan(result: TaskPlanningResult): TaskPlanningResult {
  if (result.action !== "create") {
    return result;
  }

  if (
    result.planningReason !== "single-issue"
    && result.children.length === 1
    && result.parentTitle
    && normalizePlanningTitle(result.parentTitle) === normalizePlanningTitle(result.children[0]?.title)
  ) {
    return {
      ...result,
      planningReason: "single-issue",
      parentTitle: undefined,
    };
  }

  return result;
}

export async function runTaskPlanningTurnWithExecutor(
  executeReply: TaskPlanningReplyExecutor,
  input: TaskPlanningInput,
): Promise<TaskPlanningResult> {
  const reply = await executeReply(
    buildTaskPlanningPrompt(input),
    TASK_PLANNING_SYSTEM_PROMPT,
    input.taskKey ?? `${input.channelId}-${input.rootThreadTs}-task-planning`,
  );

  return postValidateTaskPlan(parseTaskPlanningReply(reply));
}
