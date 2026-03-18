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

interface IntakeLedgerRepository {
  load(): Promise<IntakeLedgerEntry[]>;
  save(value: IntakeLedgerEntry[]): Promise<void>;
}

function findThreadEntries(
  intakeLedger: IntakeLedgerEntry[],
  message: ThreadScopedMessage,
): IntakeLedgerEntry[] {
  return intakeLedger.filter((entry) => (
    entry.sourceChannelId === message.channelId && entry.sourceThreadTs === message.rootThreadTs
  ));
}

function dropPendingClarificationEntries(
  intakeLedger: IntakeLedgerEntry[],
  message: ThreadScopedMessage,
): IntakeLedgerEntry[] {
  return intakeLedger.filter((entry) => !(
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
        issueFocusHistory: [],
        ...patch,
      },
    ];
  }

  return intakeLedger.map((entry) => (
    entry === latest
      ? {
          ...entry,
          ...patch,
          issueFocusHistory: patch.issueFocusHistory ?? entry.issueFocusHistory ?? [],
          updatedAt: support.nowIso(now),
        }
      : entry
  ));
}

export async function savePatchedThreadIntakeEntry(
  repository: IntakeLedgerRepository,
  message: ThreadMessage,
  patch: Partial<IntakeLedgerEntry>,
  now: Date,
  support: IntakeLedgerSupport,
): Promise<IntakeLedgerEntry[]> {
  const intakeLedger = await repository.load();
  const nextLedger = upsertThreadIntakeEntry(intakeLedger, message, patch, now, support);
  await repository.save(nextLedger);
  return nextLedger;
}

export async function replaceThreadPendingClarificationEntries(
  repository: IntakeLedgerRepository,
  message: ThreadScopedMessage,
  replacements: IntakeLedgerEntry[],
): Promise<IntakeLedgerEntry[]> {
  const intakeLedger = await repository.load();
  const nextLedger = [
    ...dropPendingClarificationEntries(intakeLedger, message),
    ...replacements,
  ];
  await repository.save(nextLedger);
  return nextLedger;
}
