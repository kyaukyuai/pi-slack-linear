import type { WorkgraphProjection } from "./projection.js";
import type { WorkgraphSnapshot } from "./snapshot.js";

export interface WorkgraphHealthPolicy {
  warnActiveLogEvents: number;
  autoCompactMaxActiveLogEvents: number;
}

export interface WorkgraphHealth {
  status: "ok" | "warning" | "recovery-required";
  snapshotEventCount: number;
  compactedEventCount: number;
  activeLogEventCount: number;
  snapshottedActiveLogEventCount: number;
  replayTailEventCount: number;
  issueCount: number;
  threadCount: number;
  lastOccurredAt?: string;
  snapshotInvalid: boolean;
  snapshotAheadOfLog: boolean;
  compactRecommended: boolean;
}

export function assessWorkgraphHealth(
  snapshot: WorkgraphSnapshot,
  activeLogEventCount: number,
  projection: WorkgraphProjection,
  policy: WorkgraphHealthPolicy,
): WorkgraphHealth {
  const snapshotInvalid = snapshot.compactedEventCount > snapshot.eventCount;
  const replayOffset = snapshotInvalid ? 0 : Math.max(0, snapshot.eventCount - snapshot.compactedEventCount);
  const snapshotAheadOfLog = replayOffset > activeLogEventCount;
  const snapshottedActiveLogEventCount = snapshotAheadOfLog
    ? activeLogEventCount
    : Math.min(activeLogEventCount, replayOffset);
  const replayTailEventCount = snapshotAheadOfLog
    ? 0
    : Math.max(0, activeLogEventCount - snapshottedActiveLogEventCount);
  const compactRecommended = activeLogEventCount >= policy.autoCompactMaxActiveLogEvents;
  const warning = compactRecommended || activeLogEventCount >= policy.warnActiveLogEvents;

  return {
    status: snapshotInvalid || snapshotAheadOfLog
      ? "recovery-required"
      : warning
        ? "warning"
        : "ok",
    snapshotEventCount: snapshot.eventCount,
    compactedEventCount: snapshot.compactedEventCount,
    activeLogEventCount,
    snapshottedActiveLogEventCount,
    replayTailEventCount,
    issueCount: Object.keys(projection.issues).length,
    threadCount: Object.keys(projection.threads).length,
    lastOccurredAt: snapshot.lastOccurredAt,
    snapshotInvalid,
    snapshotAheadOfLog,
    compactRecommended,
  };
}
