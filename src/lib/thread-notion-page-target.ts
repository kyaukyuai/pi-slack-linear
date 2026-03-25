import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThreadQueryReferenceItem } from "./query-continuation.js";
import type { ThreadPaths } from "./thread-workspace.js";

export interface ThreadNotionPageTarget {
  pageId: string;
  title?: string;
  url?: string | null;
  recordedAt: string;
}

function buildThreadNotionPageTargetPath(paths: ThreadPaths): string {
  return join(paths.scratchDir, "current-notion-page.json");
}

function normalizeNotionPageTarget(value: unknown): ThreadNotionPageTarget | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const pageId = typeof record.pageId === "string" ? record.pageId.trim() : "";
  const recordedAt = typeof record.recordedAt === "string" ? record.recordedAt.trim() : "";
  if (!pageId || !recordedAt) {
    return undefined;
  }

  return {
    pageId,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined,
    url: typeof record.url === "string"
      ? record.url
      : record.url === null
        ? null
        : undefined,
    recordedAt,
  };
}

export async function loadThreadNotionPageTarget(
  paths: ThreadPaths,
): Promise<ThreadNotionPageTarget | undefined> {
  try {
    const raw = await readFile(buildThreadNotionPageTargetPath(paths), "utf8");
    return normalizeNotionPageTarget(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveThreadNotionPageTarget(
  paths: ThreadPaths,
  target: ThreadNotionPageTarget,
): Promise<void> {
  await mkdir(dirname(buildThreadNotionPageTargetPath(paths)), { recursive: true });
  await writeFile(
    buildThreadNotionPageTargetPath(paths),
    `${JSON.stringify(target, null, 2)}\n`,
    "utf8",
  );
}

export async function clearThreadNotionPageTarget(paths: ThreadPaths): Promise<void> {
  try {
    await rm(buildThreadNotionPageTargetPath(paths), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function extractSingleNotionPageTargetFromReferenceItems(
  referenceItems: ThreadQueryReferenceItem[] | undefined,
  recordedAt: string,
): ThreadNotionPageTarget | undefined {
  const notionPages = (referenceItems ?? []).filter((item) => item.source === "notion");
  if (notionPages.length !== 1) {
    return undefined;
  }
  const page = notionPages[0]!;
  return {
    pageId: page.id,
    title: page.title,
    url: page.url,
    recordedAt,
  };
}

export function hasExplicitNotionPageReference(text: string): boolean {
  if (/https?:\/\/www\.notion\.so\/\S+/i.test(text)) {
    return true;
  }
  if (/\b[0-9a-f]{32}\b/i.test(text)) {
    return true;
  }
  return /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(text);
}
