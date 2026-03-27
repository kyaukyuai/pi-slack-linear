import type { LinearIssue } from "../../lib/linear.js";

export const WEBHOOK_INITIAL_PROPOSAL_MARKER = "<!-- cogito:webhook-initial-proposal:v1 -->";
export const WEBHOOK_INITIAL_PROPOSAL_HEADING = "## Cogito initial proposal";
export const WEBHOOK_INITIAL_PROPOSAL_PREFIX = `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n${WEBHOOK_INITIAL_PROPOSAL_HEADING}`;
export const WEBHOOK_INITIAL_PROPOSAL_DEDUPE_KEY_PREFIX = "webhook-initial-proposal";

export function hasWebhookInitialProposalComment(issue: Pick<LinearIssue, "comments"> | undefined): boolean {
  return (issue?.comments ?? []).some((comment) => comment.body.includes(WEBHOOK_INITIAL_PROPOSAL_MARKER));
}

export function normalizeWebhookInitialProposalCommentBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return WEBHOOK_INITIAL_PROPOSAL_PREFIX;
  }
  if (trimmed.startsWith(WEBHOOK_INITIAL_PROPOSAL_PREFIX)) {
    return trimmed;
  }
  if (trimmed.startsWith(WEBHOOK_INITIAL_PROPOSAL_MARKER)) {
    const withoutMarker = trimmed.slice(WEBHOOK_INITIAL_PROPOSAL_MARKER.length).trimStart();
    if (withoutMarker.startsWith(WEBHOOK_INITIAL_PROPOSAL_HEADING)) {
      return `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n${withoutMarker}`;
    }
    return `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n${WEBHOOK_INITIAL_PROPOSAL_HEADING}\n\n${withoutMarker}`;
  }
  if (trimmed.startsWith(WEBHOOK_INITIAL_PROPOSAL_HEADING)) {
    return `${WEBHOOK_INITIAL_PROPOSAL_MARKER}\n${trimmed}`;
  }
  return `${WEBHOOK_INITIAL_PROPOSAL_PREFIX}\n\n${trimmed}`;
}
