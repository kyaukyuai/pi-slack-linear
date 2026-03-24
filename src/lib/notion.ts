import { spawn } from "node:child_process";

export interface NotionCommandEnv {
  NOTION_API_TOKEN?: string;
  NOTION_API_VERSION?: string;
  [key: string]: string | undefined;
}

export interface SearchNotionInput {
  query: string;
  pageSize?: number;
}

export interface ListNotionInput {
  pageSize?: number;
}

export interface NotionPageSummary {
  id: string;
  object: string;
  url?: string | null;
  title?: string;
  lastEditedTime?: string | null;
  parent?: unknown;
  icon?: unknown;
}

export interface NotionDatabaseSummary {
  id: string;
  object: string;
  url?: string | null;
  title?: string;
  lastEditedTime?: string | null;
  description?: string;
}

export interface NotionPageFacts extends NotionPageSummary {
  createdTime?: string | null;
  createdBy?: unknown;
  lastEditedBy?: unknown;
  inTrash?: boolean;
  archived?: boolean;
  isLocked?: boolean;
  properties?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface NotionPageContentLine {
  type: string;
  text: string;
  depth: number;
}

export interface NotionPageContent extends NotionPageSummary {
  lines: NotionPageContentLine[];
  excerpt: string;
}

export interface QueryNotionDatabaseInput {
  databaseId: string;
  pageSize?: number;
  filterProperty?: string;
  filterOperator?: "equals" | "contains" | "on_or_after" | "on_or_before";
  filterValue?: string;
  sortProperty?: string;
  sortDirection?: "ascending" | "descending";
}

export interface NotionDatabasePropertySchema {
  name: string;
  type: string;
  options?: string[];
}

export interface NotionDatabaseFacts extends NotionDatabaseSummary {
  properties: Record<string, NotionDatabasePropertySchema>;
  raw: Record<string, unknown>;
}

export interface NotionDatabaseRowSummary {
  id: string;
  object: string;
  url?: string | null;
  title?: string;
  lastEditedTime?: string | null;
  properties?: Record<string, unknown>;
}

export interface NotionDatabaseQueryResult extends NotionDatabaseSummary {
  properties?: Record<string, NotionDatabasePropertySchema>;
  rows: NotionDatabaseRowSummary[];
}

export interface CreateNotionAgendaSectionInput {
  heading: string;
  paragraph?: string;
  bullets?: string[];
}

export interface CreateNotionAgendaInput {
  title: string;
  parentPageId: string;
  summary?: string;
  sections?: CreateNotionAgendaSectionInput[];
}

export interface UpdateNotionPageInput {
  pageId: string;
  title?: string;
  summary?: string;
  sections?: CreateNotionAgendaSectionInput[];
}

export interface NotionCreatedPage extends NotionPageSummary {
  createdTime?: string | null;
}

function ensureNotionAuthConfigured(env: NotionCommandEnv = process.env): void {
  if (!env.NOTION_API_TOKEN?.trim()) {
    throw new Error("NOTION_API_TOKEN is required for Notion API access");
  }
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildRichText(value: string): Array<Record<string, unknown>> {
  return [{
    type: "text",
    text: {
      content: value,
    },
  }];
}

function buildParagraphBlock(text: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: buildRichText(text),
    },
  };
}

function buildHeadingBlock(text: string): Record<string, unknown> {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: buildRichText(text),
    },
  };
}

function buildBulletedListBlock(text: string): Record<string, unknown> {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: buildRichText(text),
    },
  };
}

export function buildNotionShellCommand(args: string[]): string {
  return ["ntn", ...args].map((part) => shellEscape(part)).join(" ");
}

async function execNotionJson<T>(
  args: string[],
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<T> {
  ensureNotionAuthConfigured(env);
  const command = buildNotionShellCommand(args);
  const child = spawn("sh", ["-lc", command], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });

  const raw = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
      if (code !== 0) {
        reject(new Error(combined || `ntn ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
        return;
      }
      resolve(combined);
    });
  });

  if (!raw) {
    throw new Error("ntn returned empty output");
  }
  return JSON.parse(raw) as T;
}

function firstRichTextPlainText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value
    .map((item) => {
      if (item && typeof item === "object" && "plain_text" in item) {
        return String(item.plain_text);
      }
      return "";
    })
    .filter(Boolean);
  return texts.length > 0 ? texts.join("") : undefined;
}

function extractPageTitle(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  for (const property of Object.values(properties as Record<string, unknown>)) {
    if (!property || typeof property !== "object") continue;
    const record = property as Record<string, unknown>;
    if (record.type === "title") {
      const title = firstRichTextPlainText(record.title);
      if (title) return title;
    }
  }
  return undefined;
}

function extractDatabaseTitle(value: unknown): string | undefined {
  return firstRichTextPlainText(value);
}

function extractDatabaseDescription(value: unknown): string | undefined {
  return firstRichTextPlainText(value);
}

function extractOptionNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => entry.name)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return names.length > 0 ? names : undefined;
}

function simplifyDatabasePropertySchema(
  name: string,
  value: unknown,
): NotionDatabasePropertySchema | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  if (!type) {
    return undefined;
  }

  const schema: NotionDatabasePropertySchema = {
    name,
    type,
  };

  if (type === "status" && record.status && typeof record.status === "object") {
    schema.options = extractOptionNames((record.status as Record<string, unknown>).options);
  }
  if (type === "select" && record.select && typeof record.select === "object") {
    schema.options = extractOptionNames((record.select as Record<string, unknown>).options);
  }
  if (type === "multi_select" && record.multi_select && typeof record.multi_select === "object") {
    schema.options = extractOptionNames((record.multi_select as Record<string, unknown>).options);
  }

  return schema;
}

function simplifyDatabaseProperties(properties: unknown): Record<string, NotionDatabasePropertySchema> {
  if (!properties || typeof properties !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(properties as Record<string, unknown>)
      .map(([key, value]) => [key, simplifyDatabasePropertySchema(key, value)] as const)
      .filter((entry): entry is [string, NotionDatabasePropertySchema] => Boolean(entry[1])),
  );
}

function normalizePageSummary(raw: Record<string, unknown>): NotionPageSummary {
  return {
    id: String(raw.id ?? ""),
    object: String(raw.object ?? "unknown"),
    url: typeof raw.url === "string" ? raw.url : null,
    title: extractPageTitle(raw.properties),
    lastEditedTime: typeof raw.last_edited_time === "string" ? raw.last_edited_time : null,
    parent: raw.parent,
    icon: raw.icon,
  };
}

function normalizeDatabaseSummary(raw: Record<string, unknown>): NotionDatabaseSummary {
  return {
    id: String(raw.id ?? ""),
    object: String(raw.object ?? "unknown"),
    url: typeof raw.url === "string" ? raw.url : null,
    title: extractDatabaseTitle(raw.title),
    lastEditedTime: typeof raw.last_edited_time === "string" ? raw.last_edited_time : null,
    description: extractDatabaseDescription(raw.description),
  };
}

function getBlockData(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (!type) return undefined;
  const value = raw[type];
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function formatBlockPlainText(raw: Record<string, unknown>): string | undefined {
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (!type) return undefined;
  const block = getBlockData(raw);
  if (!block) return undefined;

  if (type === "child_page" && typeof block.title === "string" && block.title.trim()) {
    return block.title.trim();
  }

  if (type === "to_do") {
    const text = firstRichTextPlainText(block.rich_text);
    if (!text) return undefined;
    return `${block.checked ? "[x]" : "[ ]"} ${text}`;
  }

  if (type === "bookmark") {
    const caption = firstRichTextPlainText(block.caption);
    const url = typeof block.url === "string" ? block.url : undefined;
    return caption || url;
  }

  if (type === "link_preview") {
    return typeof block.url === "string" ? block.url : undefined;
  }

  const richText = firstRichTextPlainText(block.rich_text);
  if (richText) return richText;

  if (Array.isArray(block.title)) {
    return firstRichTextPlainText(block.title);
  }

  return undefined;
}

function buildExcerpt(lines: NotionPageContentLine[], maxLines = 4, maxLength = 280): string {
  const joined = lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(" / ");
  if (joined.length <= maxLength) return joined;
  return `${joined.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildDefaultAgendaSections(summary?: string): CreateNotionAgendaSectionInput[] {
  return [
    {
      heading: "目的",
      paragraph: summary?.trim() || "目的を記入してください。",
    },
    {
      heading: "議題",
      bullets: ["議題を追加してください。"],
    },
    {
      heading: "確認事項",
      bullets: ["確認事項を追加してください。"],
    },
    {
      heading: "次のアクション",
      bullets: ["次のアクションを追加してください。"],
    },
  ];
}

function normalizeAgendaSections(input: CreateNotionAgendaInput): CreateNotionAgendaSectionInput[] {
  const sections = input.sections?.filter((section) => section.heading.trim()) ?? [];
  if (sections.length === 0) {
    return buildDefaultAgendaSections(input.summary);
  }
  return sections;
}

function buildPageAppendChildren(
  input: Pick<UpdateNotionPageInput, "summary" | "sections">,
): Record<string, unknown>[] {
  const children: Record<string, unknown>[] = [];

  if (input.summary?.trim()) {
    children.push(buildParagraphBlock(input.summary.trim()));
  }

  for (const section of input.sections ?? []) {
    if (!section.heading.trim()) continue;
    children.push(buildHeadingBlock(section.heading.trim()));
    if (section.paragraph?.trim()) {
      children.push(buildParagraphBlock(section.paragraph.trim()));
    }
    for (const bullet of section.bullets ?? []) {
      if (!bullet.trim()) continue;
      children.push(buildBulletedListBlock(bullet.trim()));
    }
  }

  return children;
}

function buildCreateNotionAgendaPayload(input: CreateNotionAgendaInput): Record<string, unknown> {
  const title = input.title.trim();
  if (!title) throw new Error("Notion agenda title is required");
  const parentPageId = input.parentPageId.trim();
  if (!parentPageId) throw new Error("Notion agenda parent page ID is required");

  const sections = normalizeAgendaSections(input);
  const children: Record<string, unknown>[] = [];

  if (input.summary?.trim() && input.sections && input.sections.length > 0) {
    children.push(buildParagraphBlock(input.summary.trim()));
  }

  for (const section of sections) {
    children.push(buildHeadingBlock(section.heading.trim()));
    if (section.paragraph?.trim()) {
      children.push(buildParagraphBlock(section.paragraph.trim()));
    }
    for (const bullet of section.bullets ?? []) {
      if (!bullet.trim()) continue;
      children.push(buildBulletedListBlock(bullet.trim()));
    }
  }

  return {
    parent: {
      type: "page_id",
      page_id: parentPageId,
    },
    properties: {
      title: {
        title: buildRichText(title),
      },
    },
    children,
  };
}

function buildUpdateNotionPagePayload(input: Pick<UpdateNotionPageInput, "title">): Record<string, unknown> {
  const title = input.title?.trim();
  if (!title) {
    throw new Error("Notion page title is required for page property updates");
  }

  return {
    properties: {
      title: {
        title: buildRichText(title),
      },
    },
  };
}

function buildAppendNotionPageBlocksPayload(
  input: Pick<UpdateNotionPageInput, "summary" | "sections">,
): Record<string, unknown> {
  const children = buildPageAppendChildren(input);
  if (children.length === 0) {
    throw new Error("Notion page append content is required");
  }

  return {
    children,
  };
}

export function buildSearchNotionArgs(input: SearchNotionInput): string[] {
  const query = input.query.trim();
  if (!query) throw new Error("Search query is required");

  const payload = {
    query,
    page_size: input.pageSize ?? 10,
    filter: {
      property: "object",
      value: "page",
    },
  };

  return ["api", "/v1/search", "--data", JSON.stringify(payload)];
}

export function buildSearchNotionDatabasesArgs(input: SearchNotionInput): string[] {
  const query = input.query.trim();
  if (!query) throw new Error("Search query is required");

  const payload = {
    query,
    page_size: input.pageSize ?? 10,
    filter: {
      property: "object",
      value: "data_source",
    },
  };

  return ["api", "/v1/search", "--data", JSON.stringify(payload)];
}

export function buildListNotionDatabasesArgs(input: ListNotionInput = {}): string[] {
  const payload = {
    page_size: input.pageSize ?? 10,
    filter: {
      property: "object",
      value: "data_source",
    },
  };

  return ["api", "/v1/search", "--data", JSON.stringify(payload)];
}

export function buildGetNotionPageArgs(pageId: string): string[] {
  const trimmed = pageId.trim();
  if (!trimmed) throw new Error("Notion page ID is required");
  return ["api", `/v1/pages/${trimmed}`];
}

export function buildListNotionBlockChildrenArgs(pageId: string, startCursor?: string): string[] {
  const trimmed = pageId.trim();
  if (!trimmed) throw new Error("Notion page ID is required");
  const search = new URLSearchParams({ page_size: "100" });
  if (startCursor?.trim()) {
    search.set("start_cursor", startCursor.trim());
  }
  return ["api", `/v1/blocks/${trimmed}/children?${search.toString()}`];
}

export function buildGetNotionDatabaseArgs(databaseId: string): string[] {
  const trimmed = databaseId.trim();
  if (!trimmed) throw new Error("Notion database ID is required");
  return ["api", `/v1/data_sources/${trimmed}`];
}

export function buildCreateNotionAgendaArgs(input: CreateNotionAgendaInput): string[] {
  return ["api", "/v1/pages", "--data", JSON.stringify(buildCreateNotionAgendaPayload(input))];
}

export function buildUpdateNotionPageArgs(input: UpdateNotionPageInput): string[] {
  const pageId = input.pageId.trim();
  if (!pageId) throw new Error("Notion page ID is required");
  return ["api", `/v1/pages/${pageId}`, "--method", "PATCH", "--data", JSON.stringify(buildUpdateNotionPagePayload(input))];
}

export function buildAppendNotionPageBlocksArgs(input: UpdateNotionPageInput): string[] {
  const pageId = input.pageId.trim();
  if (!pageId) throw new Error("Notion page ID is required");
  return ["api", `/v1/blocks/${pageId}/children`, "--method", "PATCH", "--data", JSON.stringify(buildAppendNotionPageBlocksPayload(input))];
}

export function buildArchiveNotionPageArgs(pageId: string): string[] {
  const trimmed = pageId.trim();
  if (!trimmed) throw new Error("Notion page ID is required");
  return ["api", `/v1/pages/${trimmed}`, "--method", "PATCH", "--data", JSON.stringify({ in_trash: true })];
}

function coerceNotionFilterValue(
  schema: NotionDatabasePropertySchema | undefined,
  operator: QueryNotionDatabaseInput["filterOperator"],
  value: string,
): Record<string, unknown> | undefined {
  if (!schema || !operator) {
    return undefined;
  }

  switch (schema.type) {
    case "title":
      return { title: { [operator]: value } };
    case "rich_text":
      return { rich_text: { [operator]: value } };
    case "status":
      return operator === "equals" ? { status: { equals: value } } : undefined;
    case "select":
      return operator === "equals" ? { select: { equals: value } } : undefined;
    case "multi_select":
      return (operator === "equals" || operator === "contains") ? { multi_select: { contains: value } } : undefined;
    case "checkbox":
      return operator === "equals" ? { checkbox: { equals: value === "true" } } : undefined;
    case "number": {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || operator !== "equals") {
        return undefined;
      }
      return { number: { equals: numeric } };
    }
    case "date":
      return (operator === "equals" || operator === "on_or_after" || operator === "on_or_before")
        ? { date: { [operator]: value } }
        : undefined;
    case "relation":
      return (operator === "equals" || operator === "contains") ? { relation: { contains: value } } : undefined;
    default:
      return undefined;
  }
}

function buildNotionDatabaseQueryPayload(
  input: QueryNotionDatabaseInput,
  schemaMap?: Record<string, NotionDatabasePropertySchema>,
  startCursor?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    page_size: input.pageSize ?? 10,
  };
  if (startCursor?.trim()) {
    payload.start_cursor = startCursor.trim();
  }

  if (input.filterProperty?.trim() && input.filterOperator && input.filterValue?.trim()) {
    const property = input.filterProperty.trim();
    const filter = coerceNotionFilterValue(schemaMap?.[property], input.filterOperator, input.filterValue.trim());
    if (!filter) {
      throw new Error(`Unsupported Notion database filter for property ${property}`);
    }
    payload.filter = {
      property,
      ...filter,
    };
  }

  if (input.sortProperty?.trim()) {
    payload.sorts = [{
      property: input.sortProperty.trim(),
      direction: input.sortDirection ?? "ascending",
    }];
  }

  return payload;
}

export function buildQueryNotionDatabaseArgs(
  input: QueryNotionDatabaseInput,
  schemaMap?: Record<string, NotionDatabasePropertySchema>,
  startCursor?: string,
): string[] {
  const databaseId = input.databaseId.trim();
  if (!databaseId) throw new Error("Notion database ID is required");

  const payload = buildNotionDatabaseQueryPayload(input, schemaMap, startCursor);

  return ["api", `/v1/data_sources/${databaseId}/query`, "--data", JSON.stringify(payload)];
}

export async function searchNotionPages(
  input: SearchNotionInput,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageSummary[]> {
  const payload = await execNotionJson<{ results?: Array<Record<string, unknown>> }>(
    buildSearchNotionArgs(input),
    env,
    signal,
  );
  return (payload.results ?? [])
    .filter((item) => item.object === "page")
    .map((item) => normalizePageSummary(item));
}

export async function searchNotionDatabases(
  input: SearchNotionInput,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionDatabaseSummary[]> {
  const payload = await execNotionJson<{ results?: Array<Record<string, unknown>> }>(
    buildSearchNotionDatabasesArgs(input),
    env,
    signal,
  );
  return (payload.results ?? [])
    .filter((item) => item.object === "database" || item.object === "data_source")
    .map((item) => normalizeDatabaseSummary(item));
}

export async function listNotionDatabases(
  input: ListNotionInput = {},
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionDatabaseSummary[]> {
  const payload = await execNotionJson<{ results?: Array<Record<string, unknown>> }>(
    buildListNotionDatabasesArgs(input),
    env,
    signal,
  );
  return (payload.results ?? [])
    .filter((item) => item.object === "database" || item.object === "data_source")
    .map((item) => normalizeDatabaseSummary(item));
}

export async function getNotionPageFacts(
  pageId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageFacts> {
  const payload = await execNotionJson<Record<string, unknown>>(
    buildGetNotionPageArgs(pageId),
    env,
    signal,
  );
  const summary = normalizePageSummary(payload);
  return {
    ...summary,
    createdTime: typeof payload.created_time === "string" ? payload.created_time : null,
    createdBy: payload.created_by,
    lastEditedBy: payload.last_edited_by,
    inTrash: Boolean(payload.in_trash),
    archived: Boolean(payload.is_archived),
    isLocked: Boolean(payload.is_locked),
    properties: (payload.properties as Record<string, unknown> | undefined) ?? undefined,
    raw: payload,
  };
}

export async function getNotionDatabaseFacts(
  databaseId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionDatabaseFacts> {
  const payload = await execNotionJson<Record<string, unknown>>(
    buildGetNotionDatabaseArgs(databaseId),
    env,
    signal,
  );
  return {
    ...normalizeDatabaseSummary(payload),
    properties: simplifyDatabaseProperties(payload.properties),
    raw: payload,
  };
}

async function listNotionBlockChildren(
  blockId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  while (true) {
    const payload = await execNotionJson<{
      results?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    }>(
      buildListNotionBlockChildrenArgs(blockId, cursor),
      env,
      signal,
    );
    results.push(...(payload.results ?? []));
    if (!payload.has_more || !payload.next_cursor) {
      break;
    }
    cursor = payload.next_cursor;
  }

  return results;
}

async function collectNotionPageContentLines(
  blockId: string,
  env: NotionCommandEnv,
  signal: AbortSignal | undefined,
  depth = 0,
  options?: { maxDepth?: number; maxLines?: number },
): Promise<NotionPageContentLine[]> {
  const maxDepth = options?.maxDepth ?? 2;
  const maxLines = options?.maxLines ?? 80;
  if (depth > maxDepth || maxLines <= 0) return [];

  const blocks = await listNotionBlockChildren(blockId, env, signal);
  const lines: NotionPageContentLine[] = [];

  for (const block of blocks) {
    const type = typeof block.type === "string" ? block.type : "unknown";
    const text = formatBlockPlainText(block);
    if (text) {
      lines.push({ type, text, depth });
      if (lines.length >= maxLines) break;
    }
    if (block.has_children && depth < maxDepth && lines.length < maxLines) {
      const childLines = await collectNotionPageContentLines(
        String(block.id ?? ""),
        env,
        signal,
        depth + 1,
        { maxDepth, maxLines: maxLines - lines.length },
      );
      lines.push(...childLines);
      if (lines.length >= maxLines) break;
    }
  }

  return lines;
}

export async function getNotionPageContent(
  pageId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageContent> {
  const facts = await getNotionPageFacts(pageId, env, signal);
  const lines = await collectNotionPageContentLines(pageId, env, signal);
  return {
    id: facts.id,
    object: facts.object,
    url: facts.url,
    title: facts.title,
    lastEditedTime: facts.lastEditedTime,
    parent: facts.parent,
    icon: facts.icon,
    lines,
    excerpt: buildExcerpt(lines),
  };
}

function simplifyNotionPropertyValue(property: Record<string, unknown>): unknown {
  const type = typeof property.type === "string" ? property.type : undefined;
  if (!type) return undefined;

  switch (type) {
    case "title":
      return firstRichTextPlainText(property.title);
    case "rich_text":
      return firstRichTextPlainText(property.rich_text);
    case "select":
      return property.select && typeof property.select === "object"
        ? (property.select as Record<string, unknown>).name
        : undefined;
    case "multi_select":
      return Array.isArray(property.multi_select)
        ? property.multi_select
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => entry.name)
          .filter((entry): entry is string => typeof entry === "string")
        : [];
    case "status":
      return property.status && typeof property.status === "object"
        ? (property.status as Record<string, unknown>).name
        : undefined;
    case "date":
      return property.date && typeof property.date === "object"
        ? {
            start: (property.date as Record<string, unknown>).start,
            end: (property.date as Record<string, unknown>).end,
          }
        : undefined;
    case "people":
      return Array.isArray(property.people)
        ? property.people
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => entry.name ?? entry.id)
          .filter((entry): entry is string => typeof entry === "string")
        : [];
    case "checkbox":
      return Boolean(property.checkbox);
    case "number":
      return typeof property.number === "number" ? property.number : undefined;
    case "url":
    case "email":
    case "phone_number":
      return typeof property[type] === "string" ? property[type] : undefined;
    case "relation":
      return Array.isArray(property.relation)
        ? property.relation
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => entry.id)
          .filter((entry): entry is string => typeof entry === "string")
        : [];
    case "formula": {
      const formula = property.formula;
      if (!formula || typeof formula !== "object") return undefined;
      const formulaRecord = formula as Record<string, unknown>;
      const formulaType = typeof formulaRecord.type === "string" ? formulaRecord.type : undefined;
      if (!formulaType) return undefined;
      return formulaRecord[formulaType];
    }
    default:
      return undefined;
  }
}

function simplifyNotionPageProperties(properties: unknown): Record<string, unknown> | undefined {
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const entries = Object.entries(properties as Record<string, unknown>)
    .map(([key, value]) => {
      if (!value || typeof value !== "object") {
        return [key, undefined] as const;
      }
      return [key, simplifyNotionPropertyValue(value as Record<string, unknown>)] as const;
    })
    .filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeDatabaseRowSummary(raw: Record<string, unknown>): NotionDatabaseRowSummary {
  return {
    id: String(raw.id ?? ""),
    object: String(raw.object ?? "unknown"),
    url: typeof raw.url === "string" ? raw.url : null,
    title: extractPageTitle(raw.properties),
    lastEditedTime: typeof raw.last_edited_time === "string" ? raw.last_edited_time : null,
    properties: simplifyNotionPageProperties(raw.properties),
  };
}

export async function queryNotionDatabase(
  input: QueryNotionDatabaseInput,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionDatabaseQueryResult> {
  const database = await execNotionJson<Record<string, unknown>>(
    buildGetNotionDatabaseArgs(input.databaseId),
    env,
    signal,
  );
  const properties = simplifyDatabaseProperties(database.properties);
  const payload = await execNotionJson<{ results?: Array<Record<string, unknown>> }>(
    buildQueryNotionDatabaseArgs(input, properties),
    env,
    signal,
  );

  return {
    ...normalizeDatabaseSummary(database),
    properties,
    rows: (payload.results ?? [])
      .filter((item) => item.object === "page")
      .map((item) => normalizeDatabaseRowSummary(item)),
  };
}

export async function createNotionAgendaPage(
  input: CreateNotionAgendaInput,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionCreatedPage> {
  const payload = await execNotionJson<Record<string, unknown>>(
    buildCreateNotionAgendaArgs(input),
    env,
    signal,
  );
  return {
    ...normalizePageSummary(payload),
    createdTime: typeof payload.created_time === "string" ? payload.created_time : null,
  };
}

export async function updateNotionPage(
  input: UpdateNotionPageInput,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageFacts> {
  const pageId = input.pageId.trim();
  if (!pageId) {
    throw new Error("Notion page ID is required");
  }

  if (input.title?.trim()) {
    await execNotionJson<Record<string, unknown>>(
      buildUpdateNotionPageArgs(input),
      env,
      signal,
    );
  }

  if (buildPageAppendChildren(input).length > 0) {
    await execNotionJson<Record<string, unknown>>(
      buildAppendNotionPageBlocksArgs(input),
      env,
      signal,
    );
  }

  return getNotionPageFacts(pageId, env, signal);
}

export async function archiveNotionPage(
  pageId: string,
  env: NotionCommandEnv = process.env,
  signal?: AbortSignal,
): Promise<NotionPageFacts> {
  const trimmed = pageId.trim();
  if (!trimmed) {
    throw new Error("Notion page ID is required");
  }

  await execNotionJson<Record<string, unknown>>(
    buildArchiveNotionPageArgs(trimmed),
    env,
    signal,
  );

  return getNotionPageFacts(trimmed, env, signal);
}
