import type { LinearIssue } from "../../lib/linear.js";
import type {
  ManagerPolicy,
  OwnerMap,
  OwnerMapEntry,
} from "../../lib/manager-state.js";
import type { ResearchNextAction } from "../../lib/pi-session.js";

const ACTIONABLE_RESEARCH_PATTERN = /(確認|修正|対応|実装|調査|整理|洗い出し|作成|更新|共有|再現|検証|比較)/i;
const RESEARCH_TITLE_PATTERN = /(調査|検証|比較|リサーチ|洗い出し|調べ)/i;
const LIST_MARKER_PATTERN = /^\s*(?:[-*・•]\s+|\d+[.)]\s+)/;

function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/g, "")
    .toLowerCase();
}

function trimJapaneseParticles(text: string): string {
  return text.replace(/(?:は|を|が|に|で|と|へ|も|の)+$/u, "").trim();
}

function deriveIssueTitle(text: string): string {
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

function isResearchIssueTitle(text: string): boolean {
  return RESEARCH_TITLE_PATTERN.test(text);
}

export function chooseExistingResearchParent(
  duplicates: LinearIssue[],
  baseTitle: string,
): LinearIssue | undefined {
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

export function chooseOwner(
  text: string,
  ownerMap: OwnerMap,
): { entry: OwnerMapEntry; resolution: "mapped" | "fallback" } {
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

export function filterResearchNextActions(
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
