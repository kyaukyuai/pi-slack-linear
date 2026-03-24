import { describe, expect, it } from "vitest";
import {
  buildLinearWebhookSignature,
  isDuplicateWebhookDelivery,
  isLoopedWebhookIssue,
  parseLinearWebhookEvent,
  updateWebhookDeliveryStatus,
  upsertWebhookDelivery,
  verifyLinearWebhookRequest,
} from "../src/lib/linear-webhook.js";

describe("linear webhook helpers", () => {
  const secret = "webhook-secret";
  const rawBody = JSON.stringify({
    type: "Issue",
    action: "create",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    data: {
      id: "issue-uuid-1",
      identifier: "AIC-123",
    },
  });

  it("verifies signatures and timestamps", () => {
    const signature = buildLinearWebhookSignature(secret, rawBody);
    const ok = verifyLinearWebhookRequest({
      headers: {
        "linear-signature": signature,
      },
      rawBody,
      secret,
    });

    expect(ok).toEqual({
      ok: true,
      statusCode: 200,
    });

    expect(verifyLinearWebhookRequest({
      headers: {
        "linear-signature": "bad",
      },
      rawBody,
      secret,
    })).toMatchObject({
      ok: false,
      statusCode: 401,
    });

    const staleBody = JSON.stringify({
      type: "Issue",
      action: "create",
      webhookTimestamp: Date.now() - 120_000,
      data: {
        id: "issue-uuid-1",
        identifier: "AIC-123",
      },
    });
    expect(verifyLinearWebhookRequest({
      headers: {
        "linear-signature": buildLinearWebhookSignature(secret, staleBody),
      },
      rawBody: staleBody,
      secret,
    })).toMatchObject({
      ok: false,
      statusCode: 401,
    });
  });

  it("parses issue-create deliveries and marks unsupported events", () => {
    const receivedAt = "2026-03-24T02:30:00.000Z";
    const parsed = parseLinearWebhookEvent({
      headers: {
        "linear-delivery": "delivery-1",
      },
      rawBody,
      receivedAt,
    });

    expect(parsed).toEqual({
      kind: "issue-created",
      event: {
        deliveryId: "delivery-1",
        webhookId: "webhook-1",
        issueId: "issue-uuid-1",
        issueIdentifier: "AIC-123",
        receivedAt,
      },
    });

    expect(parseLinearWebhookEvent({
      headers: {
        "linear-delivery": "delivery-2",
      },
      rawBody: JSON.stringify({
        type: "Comment",
        action: "create",
        webhookTimestamp: Date.now(),
        data: {
          id: "comment-1",
        },
      }),
      receivedAt,
    })).toEqual({
      kind: "unsupported",
      record: {
        deliveryId: "delivery-2",
        webhookId: undefined,
        issueId: "unknown",
        issueIdentifier: "unknown",
        receivedAt,
        status: "ignored-unsupported",
        reason: "unsupported event: type=Comment action=create",
        createdIssueIds: [],
      },
    });
  });

  it("tracks dedupe and loop prevention in delivery ledgers", () => {
    const deliveries = upsertWebhookDelivery([], {
      deliveryId: "delivery-1",
      webhookId: "webhook-1",
      issueId: "issue-uuid-1",
      issueIdentifier: "AIC-123",
      receivedAt: "2026-03-24T02:30:00.000Z",
      status: "received",
      createdIssueIds: [],
    });

    expect(isDuplicateWebhookDelivery(deliveries, "delivery-1")).toBe(true);
    expect(isLoopedWebhookIssue(deliveries, "AIC-123")).toBe(false);

    const updated = updateWebhookDeliveryStatus(deliveries, "delivery-1", {
      status: "committed",
      createdIssueIds: ["AIC-124", "AIC-125"],
    });
    expect(isLoopedWebhookIssue(updated, "AIC-124", "issue-uuid-124")).toBe(true);
    expect(updated[0]).toMatchObject({
      status: "committed",
      createdIssueIds: ["AIC-124", "AIC-125"],
    });
  });
});
