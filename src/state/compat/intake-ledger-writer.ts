import type { CompatIntakeLedgerEntry } from "./intake-ledger-contract.js";
import type { CompatIntakeRepository, ManagerRepositories } from "../repositories/file-backed-manager-repositories.js";

interface ThreadScopedMessage {
  channelId: string;
  rootThreadTs: string;
}

interface ThreadMessage extends ThreadScopedMessage {
  messageTs: string;
  text: string;
}

export interface CompatIntakeLedgerWriterSupport {
  fingerprintText(text: string): string;
  nowIso(now: Date): string;
}

export interface CompatIntakeLedgerWriter {
  writeClarificationRequested(input: {
    message: ThreadMessage;
    sourceMessageTs?: string;
    messageFingerprint: string;
    clarificationQuestion?: string;
    clarificationReasons: string[];
    originalText: string;
    createdAt?: string;
    now: Date;
  }): Promise<void>;
  writeLinkedExisting(input: {
    message: ThreadMessage;
    sourceMessageTs?: string;
    messageFingerprint: string;
    linkedIssueIds: string[];
    lastResolvedIssueId?: string;
    originalText: string;
    now: Date;
  }): Promise<void>;
  writeCreated(input: {
    message: ThreadMessage;
    sourceMessageTs?: string;
    messageFingerprint: string;
    parentIssueId?: string;
    childIssueIds: string[];
    ownerResolution?: CompatIntakeLedgerEntry["ownerResolution"];
    originalText: string;
    lastResolvedIssueId?: string;
    now: Date;
  }): Promise<void>;
  patchLastResolvedIssue(input: {
    message: ThreadMessage;
    issueId: string;
    now: Date;
  }): Promise<void>;
  patchIssueStatus(input: {
    message: ThreadMessage;
    status: string;
    lastResolvedIssueId?: string;
    now: Date;
  }): Promise<void>;
}

function findThreadEntries(
  intakeLedger: CompatIntakeLedgerEntry[],
  message: ThreadScopedMessage,
): CompatIntakeLedgerEntry[] {
  return intakeLedger.filter((entry) => (
    entry.sourceChannelId === message.channelId && entry.sourceThreadTs === message.rootThreadTs
  ));
}

function dropPendingClarificationEntries(
  intakeLedger: CompatIntakeLedgerEntry[],
  message: ThreadScopedMessage,
): CompatIntakeLedgerEntry[] {
  return intakeLedger.filter((entry) => !(
    entry.sourceChannelId === message.channelId
    && entry.sourceThreadTs === message.rootThreadTs
    && entry.status === "needs-clarification"
  ));
}

function upsertThreadIntakeEntry(
  intakeLedger: CompatIntakeLedgerEntry[],
  message: ThreadMessage,
  patch: Partial<CompatIntakeLedgerEntry>,
  now: Date,
  support: CompatIntakeLedgerWriterSupport,
): CompatIntakeLedgerEntry[] {
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
        ...patch,
      },
    ];
  }

  return intakeLedger.map((entry) => (
    entry === latest
      ? {
          ...entry,
          ...patch,
          updatedAt: support.nowIso(now),
        }
      : entry
  ));
}

async function replaceThreadPendingClarificationEntries(
  repository: CompatIntakeRepository,
  message: ThreadScopedMessage,
  replacements: CompatIntakeLedgerEntry[],
): Promise<void> {
  const intakeLedger = await repository.load();
  const nextLedger = [
    ...dropPendingClarificationEntries(intakeLedger, message),
    ...replacements,
  ];
  await repository.save(nextLedger);
}

async function savePatchedThreadIntakeEntry(
  repository: CompatIntakeRepository,
  message: ThreadMessage,
  patch: Partial<CompatIntakeLedgerEntry>,
  now: Date,
  support: CompatIntakeLedgerWriterSupport,
): Promise<void> {
  const intakeLedger = await repository.load();
  const nextLedger = upsertThreadIntakeEntry(intakeLedger, message, patch, now, support);
  await repository.save(nextLedger);
}

export function createCompatIntakeLedgerWriter(
  repository: CompatIntakeRepository,
  support: CompatIntakeLedgerWriterSupport,
): CompatIntakeLedgerWriter {
  return {
    async writeClarificationRequested({
      message,
      sourceMessageTs,
      messageFingerprint,
      clarificationQuestion,
      clarificationReasons,
      originalText,
      createdAt,
      now,
    }): Promise<void> {
      await replaceThreadPendingClarificationEntries(repository, message, [{
        sourceChannelId: message.channelId,
        sourceThreadTs: message.rootThreadTs,
        sourceMessageTs: sourceMessageTs ?? message.messageTs,
        messageFingerprint,
        childIssueIds: [],
        status: "needs-clarification",
        originalText,
        clarificationQuestion,
        clarificationReasons,
        createdAt: createdAt ?? support.nowIso(now),
        updatedAt: support.nowIso(now),
      }]);
    },

    async writeLinkedExisting({
      message,
      sourceMessageTs,
      messageFingerprint,
      linkedIssueIds,
      lastResolvedIssueId,
      originalText,
      now,
    }): Promise<void> {
      await replaceThreadPendingClarificationEntries(repository, message, [{
        sourceChannelId: message.channelId,
        sourceThreadTs: message.rootThreadTs,
        sourceMessageTs: sourceMessageTs ?? message.messageTs,
        messageFingerprint,
        childIssueIds: linkedIssueIds,
        status: "linked-existing",
        lastResolvedIssueId,
        originalText,
        clarificationReasons: [],
        createdAt: support.nowIso(now),
        updatedAt: support.nowIso(now),
      }]);
    },

    async writeCreated({
      message,
      sourceMessageTs,
      messageFingerprint,
      parentIssueId,
      childIssueIds,
      ownerResolution,
      originalText,
      lastResolvedIssueId,
      now,
    }): Promise<void> {
      await replaceThreadPendingClarificationEntries(repository, message, [{
        sourceChannelId: message.channelId,
        sourceThreadTs: message.rootThreadTs,
        sourceMessageTs: sourceMessageTs ?? message.messageTs,
        messageFingerprint,
        parentIssueId,
        childIssueIds,
        status: "created",
        ownerResolution,
        originalText,
        clarificationReasons: [],
        lastResolvedIssueId,
        createdAt: support.nowIso(now),
        updatedAt: support.nowIso(now),
      }]);
    },

    async patchLastResolvedIssue({
      message,
      issueId,
      now,
    }): Promise<void> {
      await savePatchedThreadIntakeEntry(
        repository,
        message,
        { lastResolvedIssueId: issueId },
        now,
        support,
      );
    },

    async patchIssueStatus({
      message,
      status,
      lastResolvedIssueId,
      now,
    }): Promise<void> {
      await savePatchedThreadIntakeEntry(
        repository,
        message,
        {
          status,
          lastResolvedIssueId,
        },
        now,
        support,
      );
    },
  };
}

export function createCompatIntakeLedgerWriterFromRepositories(
  repositories: Pick<ManagerRepositories, "compatIntake">,
  support: CompatIntakeLedgerWriterSupport,
): CompatIntakeLedgerWriter {
  return createCompatIntakeLedgerWriter(repositories.compatIntake, support);
}
