import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { WebhookDeliveryEntry } from "../state/manager-state-contract.js";

export const LINEAR_ISSUE_CREATED_WEBHOOK_LABEL = "cogito-work-manager-issue-created";
export const LINEAR_WEBHOOK_MAX_AGE_MS = 60_000;

interface LinearWebhookEnvelope {
  type?: unknown;
  action?: unknown;
  webhookId?: unknown;
  webhookTimestamp?: unknown;
  data?: unknown;
}

interface LinearWebhookIssueData {
  id?: unknown;
  identifier?: unknown;
}

export interface LinearIssueCreatedWebhookEvent {
  deliveryId: string;
  webhookId?: string;
  issueId: string;
  issueIdentifier: string;
  receivedAt: string;
}

export interface LinearWebhookVerificationResult {
  ok: boolean;
  statusCode: number;
  error?: string;
}

export type LinearWebhookParseResult =
  | {
      kind: "issue-created";
      event: LinearIssueCreatedWebhookEvent;
    }
  | {
      kind: "unsupported";
      record: WebhookDeliveryEntry;
    };

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  return value?.trim() || undefined;
}

function normalizeSignature(signature: string): string {
  const trimmed = signature.trim();
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return undefined;
    return trimmed.length > 10 ? numeric : numeric * 1000;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseEnvelope(rawBody: string): LinearWebhookEnvelope {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Linear webhook payload must be an object");
  }
  return parsed as LinearWebhookEnvelope;
}

export function buildLinearWebhookSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyLinearWebhookRequest(args: {
  headers: IncomingHttpHeaders;
  rawBody: string;
  secret: string;
  now?: number;
  maxAgeMs?: number;
}): LinearWebhookVerificationResult {
  const signature = headerValue(args.headers, "linear-signature");
  if (!signature) {
    return { ok: false, statusCode: 401, error: "Missing Linear-Signature header" };
  }

  let envelope: LinearWebhookEnvelope;
  try {
    envelope = parseEnvelope(args.rawBody);
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      error: error instanceof Error ? error.message : "Invalid webhook JSON body",
    };
  }

  const timestampMs = normalizeTimestampMs(envelope.webhookTimestamp);
  if (!timestampMs) {
    return { ok: false, statusCode: 400, error: "Missing or invalid webhookTimestamp" };
  }

  const now = args.now ?? Date.now();
  const maxAgeMs = args.maxAgeMs ?? LINEAR_WEBHOOK_MAX_AGE_MS;
  if (Math.abs(now - timestampMs) > maxAgeMs) {
    return { ok: false, statusCode: 401, error: "Stale webhookTimestamp" };
  }

  const expected = Buffer.from(buildLinearWebhookSignature(args.secret, args.rawBody));
  const received = Buffer.from(normalizeSignature(signature));
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, statusCode: 401, error: "Invalid webhook signature" };
  }

  return { ok: true, statusCode: 200 };
}

export function parseLinearWebhookEvent(args: {
  headers: IncomingHttpHeaders;
  rawBody: string;
  receivedAt?: string;
}): LinearWebhookParseResult {
  const envelope = parseEnvelope(args.rawBody);
  const deliveryId = headerValue(args.headers, "linear-delivery");
  if (!deliveryId) {
    throw new Error("Missing Linear-Delivery header");
  }

  const receivedAt = args.receivedAt ?? new Date().toISOString();
  const recordBase: WebhookDeliveryEntry = {
    deliveryId,
    webhookId: asNonEmptyString(envelope.webhookId),
    issueId: "unknown",
    issueIdentifier: "unknown",
    receivedAt,
    status: "ignored-unsupported",
    createdIssueIds: [],
  };

  const issueData = (envelope.data ?? {}) as LinearWebhookIssueData;
  const issueId = asNonEmptyString(issueData.id) ?? "unknown";
  const issueIdentifier = asNonEmptyString(issueData.identifier) ?? issueId;

  if (envelope.type === "Issue" && envelope.action === "create" && issueId !== "unknown") {
    return {
      kind: "issue-created",
      event: {
        deliveryId,
        webhookId: asNonEmptyString(envelope.webhookId),
        issueId,
        issueIdentifier,
        receivedAt,
      },
    };
  }

  return {
    kind: "unsupported",
    record: {
      ...recordBase,
      reason: `unsupported event: type=${String(envelope.type ?? "unknown")} action=${String(envelope.action ?? "unknown")}`,
    },
  };
}

export function isDuplicateWebhookDelivery(
  deliveries: WebhookDeliveryEntry[],
  deliveryId: string,
): boolean {
  return deliveries.some((entry) => entry.deliveryId === deliveryId);
}

export function isLoopedWebhookIssue(
  deliveries: WebhookDeliveryEntry[],
  ...candidateIds: string[]
): boolean {
  const normalizedCandidates = candidateIds.map((value) => value.trim()).filter(Boolean);
  return deliveries.some((entry) => entry.createdIssueIds.some((value) => normalizedCandidates.includes(value)));
}

export function upsertWebhookDelivery(
  deliveries: WebhookDeliveryEntry[],
  next: WebhookDeliveryEntry,
): WebhookDeliveryEntry[] {
  const index = deliveries.findIndex((entry) => entry.deliveryId === next.deliveryId);
  if (index < 0) {
    return [...deliveries, next];
  }
  return deliveries.map((entry, entryIndex) => (entryIndex === index ? next : entry));
}

export function updateWebhookDeliveryStatus(
  deliveries: WebhookDeliveryEntry[],
  deliveryId: string,
  patch: Partial<Omit<WebhookDeliveryEntry, "deliveryId">>,
): WebhookDeliveryEntry[] {
  return deliveries.map((entry) => (
    entry.deliveryId === deliveryId
      ? {
          ...entry,
          ...patch,
          deliveryId: entry.deliveryId,
          createdIssueIds: patch.createdIssueIds ?? entry.createdIssueIds,
        }
      : entry
  ));
}
