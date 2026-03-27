import {
  searchLinearIssues,
  type LinearCommandEnv,
  type LinearIssue,
} from "./linear.js";

export interface LinearDuplicateCandidate {
  identifier: string;
  title: string;
  url?: string | null;
  state?: string | null;
  stateType?: string | null;
  updatedAt?: string | null;
  normalizedTitle: string;
  matchedQueries: string[];
  matchedTokenCount: number;
}

export interface FindLinearDuplicateCandidatesInput {
  text: string;
  limit?: number;
}

export interface DuplicateCandidateQueryResult {
  query: string;
  issues: LinearIssue[];
}

const DEFAULT_DUPLICATE_CANDIDATE_LIMIT = 5;
const SEARCH_LIMIT_PER_QUERY = 5;
const DUPLICATE_QUERY_LIMIT = 6;

const PUNCTUATION_PATTERN = /[“”"'`´’‘「」『』（）()［］\[\]【】{}<>〈〉《》・,，、。.!！?？:：;；/／\\|｜]+/gu;
const HONORIFIC_AND_PARTICLE_PATTERNS = [
  /さん/gu,
  /様/gu,
  /ちゃん/gu,
  /くん/gu,
  /氏/gu,
  /について/gu,
  /に対して/gu,
  /から/gu,
  /まで/gu,
  /より/gu,
  /との/gu,
  /への/gu,
  /へ/gu,
  /で/gu,
  /は/gu,
  /が/gu,
  /を/gu,
  /に/gu,
  /の/gu,
  /と/gu,
  /や/gu,
];
const VERB_AND_FILLER_PATTERNS = [
  /してください/gu,
  /して下さい/gu,
  /しておいて/gu,
  /してもらう/gu,
  /してもらって/gu,
  /してほしい/gu,
  /して欲しい/gu,
  /している/gu,
  /してる/gu,
  /したい/gu,
  /した/gu,
  /して/gu,
  /する/gu,
  /もらう/gu,
  /お願い/gu,
  /依頼/gu,
  /追加/gu,
  /各/gu,
  /後ほど/gu,
  /あとで/gu,
  /後から/gu,
  /あとから/gu,
];
const GENERIC_CORE_TOKENS = new Set([
  "task",
  "tasks",
  "issue",
  "issues",
  "こと",
  "もの",
  "件",
  "対応",
]);
const SPLITTABLE_ACTION_SUFFIXES = [
  "招待",
  "確認",
  "依頼",
  "追加",
  "作成",
  "設定",
  "修正",
  "更新",
  "移行",
  "共有",
  "説明",
  "通知",
  "連絡",
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function normalizeDuplicateCandidateText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(PUNCTUATION_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyPatterns(text: string, patterns: RegExp[]): string {
  return patterns.reduce((result, pattern) => result.replace(pattern, " "), text);
}

function splitCompoundToken(token: string): string[] {
  for (const suffix of SPLITTABLE_ACTION_SUFFIXES) {
    if (token.endsWith(suffix) && token.length > suffix.length + 1) {
      const prefix = token.slice(0, -suffix.length).trim();
      return [prefix, suffix].filter(Boolean);
    }
  }
  return [token];
}

function extractDuplicateSearchTokens(text: string, mode: "broad" | "core"): string[] {
  const normalized = normalizeDuplicateCandidateText(text);
  const mildSeparated = applyPatterns(normalized, HONORIFIC_AND_PARTICLE_PATTERNS);
  const source = mode === "core" ? applyPatterns(mildSeparated, VERB_AND_FILLER_PATTERNS) : mildSeparated;
  const rawTokens = source.match(/[a-z0-9]+|[一-龯]+|[ァ-ヶー]+|[ぁ-ん]+/gu) ?? [];
  const expanded = rawTokens.flatMap((token) => splitCompoundToken(token.trim()));
  return unique(expanded.filter((token) => {
    if (!token) return false;
    if (mode === "core") {
      if (GENERIC_CORE_TOKENS.has(token)) return false;
      if (/^[ぁ-ん]{1,2}$/u.test(token)) return false;
      if (/^[a-z]$/u.test(token)) return false;
      if (token.length === 1 && !/^[0-9]+$/u.test(token)) return false;
    }
    return true;
  }));
}

export function buildDuplicateCandidateQueryVariants(text: string): string[] {
  const broadTokens = extractDuplicateSearchTokens(text, "broad");
  const coreTokens = extractDuplicateSearchTokens(text, "core");
  const queries: string[] = [];
  const pushQuery = (tokens: string[]) => {
    const query = tokens.join(" ").trim();
    if (query) {
      queries.push(query);
    }
  };

  pushQuery(broadTokens);
  pushQuery(coreTokens);
  pushQuery(coreTokens.slice(0, 4));
  if (coreTokens.length >= 3) {
    pushQuery(coreTokens.slice(0, 3));
    pushQuery(coreTokens.slice(-3));
  }
  if (coreTokens.length >= 2) {
    pushQuery(coreTokens.slice(0, 2));
    pushQuery(coreTokens.slice(-2));
  }

  return unique(queries).slice(0, DUPLICATE_QUERY_LIMIT);
}

function countMatchedTokens(requestText: string, issue: LinearIssue): number {
  const requestTokens = extractDuplicateSearchTokens(requestText, "core");
  if (requestTokens.length === 0) {
    return 0;
  }
  const normalizedTitle = normalizeDuplicateCandidateText(issue.title);
  const issueTokens = extractDuplicateSearchTokens(issue.title, "core");
  return requestTokens.filter((token) => (
    normalizedTitle.includes(token)
    || issueTokens.some((issueToken) => issueToken.includes(token) || token.includes(issueToken))
  )).length;
}

function compareUpdatedAt(left: string | null | undefined, right: string | null | undefined): number {
  const leftTime = left ? Date.parse(left) : 0;
  const rightTime = right ? Date.parse(right) : 0;
  return rightTime - leftTime;
}

export function mergeDuplicateCandidateQueryResults(args: {
  requestText: string;
  queryResults: DuplicateCandidateQueryResult[];
  limit?: number;
}): LinearDuplicateCandidate[] {
  const candidates = new Map<string, { issue: LinearIssue; matchedQueries: Set<string> }>();

  for (const result of args.queryResults) {
    for (const issue of result.issues) {
      const existing = candidates.get(issue.identifier);
      if (existing) {
        existing.matchedQueries.add(result.query);
        continue;
      }
      candidates.set(issue.identifier, {
        issue,
        matchedQueries: new Set([result.query]),
      });
    }
  }

  return Array.from(candidates.values())
    .map(({ issue, matchedQueries }) => ({
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state?.name ?? null,
      stateType: issue.state?.type ?? null,
      updatedAt: issue.updatedAt ?? null,
      normalizedTitle: normalizeDuplicateCandidateText(issue.title),
      matchedQueries: Array.from(matchedQueries),
      matchedTokenCount: countMatchedTokens(args.requestText, issue),
    }))
    .sort((left, right) => (
      right.matchedQueries.length - left.matchedQueries.length
      || right.matchedTokenCount - left.matchedTokenCount
      || compareUpdatedAt(left.updatedAt, right.updatedAt)
      || left.identifier.localeCompare(right.identifier)
    ))
    .slice(0, args.limit ?? DEFAULT_DUPLICATE_CANDIDATE_LIMIT);
}

export async function findLinearDuplicateCandidates(
  input: FindLinearDuplicateCandidatesInput,
  env: LinearCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<LinearDuplicateCandidate[]> {
  const queries = buildDuplicateCandidateQueryVariants(input.text);
  if (queries.length === 0) {
    return [];
  }

  const queryResults = await Promise.all(queries.map(async (query) => ({
    query,
    issues: await searchLinearIssues(
      {
        query,
        limit: Math.max(input.limit ?? DEFAULT_DUPLICATE_CANDIDATE_LIMIT, SEARCH_LIMIT_PER_QUERY),
      },
      env,
      signal,
    ),
  })));

  return mergeDuplicateCandidateQueryResults({
    requestText: input.text,
    queryResults,
    limit: input.limit,
  });
}
