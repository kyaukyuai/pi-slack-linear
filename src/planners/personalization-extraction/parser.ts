import { personalizationExtractionSchema, type PersonalizationExtractionResult } from "./contract.js";

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

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function looksLikeIssueLevelStatus(text: string): boolean {
  return /AIC-\d+/i.test(text)
    || /\b(?:Backlog|In Progress|In Review|Done|Blocked|Canceled|Cancelled)\b/i.test(text)
    || /(?:現在|進捗)\s*\d+%/.test(text)
    || /現在\s*(?:Backlog|In Progress|In Review|Done|Blocked|Canceled|Cancelled)/i.test(text);
}

function normalizeObservation(value: unknown): PersonalizationExtractionResult["observations"][number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "ignore") {
    return { kind: "ignore" };
  }
  if (kind !== "operating_rule" && kind !== "preference_or_fact") {
    return undefined;
  }

  const source = record.source;
  const category = record.category;
  const projectName = trimNonEmptyString(record.projectName);
  const summary = trimNonEmptyString(record.summary);
  const canonicalText = trimNonEmptyString(record.canonicalText);
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? record.confidence
    : undefined;

  if (
    (source !== "explicit" && source !== "inferred")
    || (category !== "workflow"
      && category !== "reply-style"
      && category !== "priority"
      && category !== "terminology"
      && category !== "project-overview"
      && category !== "members-and-roles"
      && category !== "roadmap-and-milestones"
      && category !== "people-and-projects"
      && category !== "preferences"
      && category !== "context")
    || !summary
    || !canonicalText
    || typeof confidence !== "number"
  ) {
    return { kind: "ignore" };
  }

  if (
    (category === "project-overview" || category === "members-and-roles" || category === "roadmap-and-milestones")
    && !projectName
  ) {
    return { kind: "ignore" };
  }

  if (category === "roadmap-and-milestones" && looksLikeIssueLevelStatus(`${summary} ${canonicalText}`)) {
    return { kind: "ignore" };
  }

  return {
    kind,
    source,
    category,
    projectName,
    summary,
    canonicalText,
    confidence,
  };
}

export function parsePersonalizationExtractionReply(reply: string): PersonalizationExtractionResult {
  const jsonText = extractJsonObject(reply);
  if (!jsonText) {
    throw new Error("Personalization extraction reply did not contain a JSON object");
  }

  const parsed = JSON.parse(jsonText) as { observations?: unknown } | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Personalization extraction reply did not contain an object payload");
  }
  if (!Array.isArray(parsed.observations)) {
    throw new Error("Personalization extraction reply did not contain an observations array");
  }

  const observations = parsed.observations
    .map(normalizeObservation)
    .filter((value): value is PersonalizationExtractionResult["observations"][number] => Boolean(value))
    .slice(0, 5);

  return personalizationExtractionSchema.parse({
    observations: observations.length > 0 ? observations : [{ kind: "ignore" }],
  });
}
