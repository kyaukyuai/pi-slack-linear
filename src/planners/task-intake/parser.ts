import { taskPlanningSchema, type TaskPlanningResult } from "./contract.js";

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return undefined;
}

export function parseTaskPlanningReply(reply: string): TaskPlanningResult {
  const jsonText = extractJsonObject(reply);
  if (!jsonText) {
    throw new Error("Task planner reply did not contain a JSON object");
  }

  const parsed = taskPlanningSchema.parse(JSON.parse(jsonText));
  if (parsed.action === "clarify") {
    return {
      action: "clarify",
      clarificationQuestion: parsed.clarificationQuestion,
      clarificationReasons: parsed.clarificationReasons,
    };
  }

  if (parsed.action === "update_existing") {
    return {
      action: "update_existing",
      targetIssueId: parsed.targetIssueId,
      title: parsed.title,
      description: parsed.description,
      dueDate: parsed.dueDate ?? undefined,
      assigneeHint: parsed.assigneeHint ?? undefined,
    };
  }

  return {
    action: "create",
    planningReason: parsed.planningReason,
    parentTitle: parsed.parentTitle ?? undefined,
    parentDueDate: parsed.parentDueDate ?? undefined,
    children: parsed.children.map((child) => ({
      title: child.title,
      kind: child.kind,
      dueDate: child.dueDate ?? undefined,
      assigneeHint: child.assigneeHint ?? undefined,
    })),
  };
}
