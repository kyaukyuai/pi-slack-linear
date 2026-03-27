const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebPageSummary {
  url: string;
  title?: string;
  snippet?: string;
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeSearchUrl(rawUrl: string): string {
  try {
    const candidate = new URL(rawUrl, SEARCH_ENDPOINT);
    const direct = candidate.searchParams.get("uddg");
    return direct ? decodeURIComponent(direct) : candidate.toString();
  } catch {
    return rawUrl;
  }
}

export function parseWebSearchResultsHtml(html: string, limit: number): WebSearchResult[] {
  const links = Array.from(
    html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi),
  );
  const snippets = Array.from(
    html.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi),
  );

  return links.slice(0, limit).map((match, index) => ({
    url: decodeSearchUrl(match[1] ?? ""),
    title: stripHtml(match[2] ?? ""),
    snippet: stripHtml(snippets[index]?.[1] ?? ""),
  })).filter((entry) => entry.url && entry.title);
}

export async function webSearchFetch(
  query: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const response = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(trimmed)}`, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Web search failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return parseWebSearchResultsHtml(html, Math.max(1, Math.min(limit, 10)));
}

export async function webFetchUrl(url: string, signal?: AbortSignal): Promise<WebPageSummary> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
    },
    signal,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const body = stripHtml(html);

  return {
    url: response.url || url,
    title: title || undefined,
    snippet: body.slice(0, 280) || undefined,
  };
}
