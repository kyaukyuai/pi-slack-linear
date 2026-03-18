import type { IntakeLedgerEntry } from "../../state/manager-state-contract.js";

interface ThreadScopedMessage {
  channelId: string;
  rootThreadTs: string;
}

interface ThreadMessage extends ThreadScopedMessage {
  messageTs: string;
  text: string;
}

export interface IntakeLedgerSupport {
  fingerprintText(text: string): string;
  nowIso(now: Date): string;
}

function findThreadEntries(
  intakeLedger: IntakeLedgerEntry[],
  message: ThreadScopedMessage,
): IntakeLedgerEntry[] {
  return intakeLedger.filter((entry) => (
    entry.sourceChannelId === message.channelId && entry.sourceThreadTs === message.rootThreadTs
  ));
}

function appendIssueFocusHistory(
  existing: IntakeLedgerEntry["issueFocusHistory"] | undefined,
  nextEvents: NonNullable<IntakeLedgerEntry["issueFocusHistory"]>,
): NonNullable<IntakeLedgerEntry["issueFocusHistory"]> {
  return [...(existing ?? []), ...nextEvents].slice(-20);
}

export function findPendingClarification(
  intakeLedger: IntakeLedgerEntry[],
  message: ThreadScopedMessage,
): IntakeLedgerEntry | undefined {
  return [...intakeLedger]
    .reverse()
    .find((entry) => (
      entry.sourceChannelId === message.channelId
      && entry.sourceThreadTs === message.rootThreadTs
      && entry.status === "needs-clarification"
    ));
}

export function buildIntakeKey(
  entry: Pick<IntakeLedgerEntry, "sourceChannelId" | "sourceThreadTs" | "messageFingerprint">,
): string {
  return `${entry.sourceChannelId}:${entry.sourceThreadTs}:${entry.messageFingerprint}`;
}

export function buildIssueFocusEvent(
  issueId: string,
  actionKind: string,
  source: string,
  textSnippet: string | undefined,
  now: Date,
  support: Pick<IntakeLedgerSupport, "nowIso">,
): NonNullable<IntakeLedgerEntry["issueFocusHistory"]>[number] {
  return {
    issueId,
    actionKind,
    source,
    ts: support.nowIso(now),
    textSnippet: textSnippet?.replace(/\s+/g, " ").trim().slice(0, 140) || undefined,
  };
}

export function upsertThreadIntakeEntry(
  intakeLedger: IntakeLedgerEntry[],
  message: ThreadMessage,
  patch: Partial<IntakeLedgerEntry>,
  now: Date,
  support: IntakeLedgerSupport,
): IntakeLedgerEntry[] {
  const threadEntries = findThreadEntries(intakeLedger, message);
  const latest = threadEntries[threadEntries.length - 1];

  if (!latest) {
    const issueFocusHistory = patch.issueFocusHistory
      ? appendIssueFocusHistory([], patch.issueFocusHistory)
      : [];
    return [
      ...intakeLedger,
      {
        sourceChannelId: message.channelId,
        sourceThreadTs: message.rootThreadTs,
        sourceMessageTs: message.messageTs,
        messageFingerprint: support.fingerprintText(message.text) || message.messageTs,
        childIssueIds: [],
        status: patch.status ?? "created",
        clarificationReasons: [],
        originalText: message.text,
        createdAt: support.nowIso(now),
        updatedAt: support.nowIso(now),
        ...patch,
        issueFocusHistory,
      },
    ];
  }

  return intakeLedger.map((entry) => (
    entry === latest
      ? {
          ...entry,
          ...patch,
          issueFocusHistory: patch.issueFocusHistory
            ? appendIssueFocusHistory(entry.issueFocusHistory, patch.issueFocusHistory)
            : entry.issueFocusHistory,
          updatedAt: support.nowIso(now),
        }
      : entry
  ));
}
