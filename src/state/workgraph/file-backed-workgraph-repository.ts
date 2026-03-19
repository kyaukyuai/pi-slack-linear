import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SystemPaths } from "../../lib/system-workspace.js";
import {
  createWorkgraphEvent,
  workgraphEventSchema,
  type WorkgraphEvent,
  type WorkgraphEventInput,
} from "./events.js";
import { projectWorkgraph, type WorkgraphProjection } from "./projection.js";
import { assessWorkgraphHealth, type WorkgraphHealth, type WorkgraphHealthPolicy } from "./health.js";
import {
  EMPTY_WORKGRAPH_SNAPSHOT,
  workgraphSnapshotSchema,
  type WorkgraphSnapshot,
} from "./snapshot.js";

export interface WorkgraphRepository {
  list(): Promise<WorkgraphEvent[]>;
  append(events: WorkgraphEventInput | WorkgraphEventInput[]): Promise<WorkgraphEvent[]>;
  project(): Promise<WorkgraphProjection>;
  loadSnapshot(): Promise<WorkgraphSnapshot>;
  rebuildSnapshot(): Promise<WorkgraphSnapshot>;
  compact(): Promise<WorkgraphSnapshot>;
  recoverSnapshotFromLog(): Promise<WorkgraphSnapshot>;
  health(policy: WorkgraphHealthPolicy): Promise<WorkgraphHealth>;
}

export function createFileBackedWorkgraphRepository(paths: SystemPaths): WorkgraphRepository {
  const list = async (): Promise<WorkgraphEvent[]> => {
    try {
      const raw = await readFile(paths.workgraphEventsFile, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => workgraphEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  };

  const loadSnapshot = async (): Promise<WorkgraphSnapshot> => {
    try {
      const raw = await readFile(paths.workgraphSnapshotFile, "utf8");
      return workgraphSnapshotSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return EMPTY_WORKGRAPH_SNAPSHOT;
      }
      throw error;
    }
  };

  const writeSnapshot = async (snapshot: WorkgraphSnapshot): Promise<void> => {
    await mkdir(dirname(paths.workgraphSnapshotFile), { recursive: true });
    await writeFile(paths.workgraphSnapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  };

  const projectFromStoredState = async (): Promise<{
    snapshot: WorkgraphSnapshot;
    events: WorkgraphEvent[];
    projection: WorkgraphProjection;
  }> => {
    const [snapshot, events] = await Promise.all([loadSnapshot(), list()]);
    const replayStart = Math.max(0, snapshot.eventCount - snapshot.compactedEventCount);
    if (replayStart > events.length) {
      return {
        snapshot,
        events,
        projection: projectWorkgraph([], snapshot),
      };
    }
    return {
      snapshot,
      events,
      projection: projectWorkgraph(events.slice(replayStart), snapshot),
    };
  };

  return {
    list,
    async append(events: WorkgraphEventInput | WorkgraphEventInput[]): Promise<WorkgraphEvent[]> {
      const normalized = Array.isArray(events) ? events : [events];
      if (normalized.length === 0) {
        return [];
      }

      const persisted = normalized.map((event) => createWorkgraphEvent(event));
      await mkdir(dirname(paths.workgraphEventsFile), { recursive: true });
      await appendFile(
        paths.workgraphEventsFile,
        `${persisted.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
      return persisted;
    },
    loadSnapshot,
    async project(): Promise<WorkgraphProjection> {
      return (await projectFromStoredState()).projection;
    },
    async health(policy: WorkgraphHealthPolicy): Promise<WorkgraphHealth> {
      const { snapshot, events, projection } = await projectFromStoredState();
      return assessWorkgraphHealth(snapshot, events.length, projection, policy);
    },
    async rebuildSnapshot(): Promise<WorkgraphSnapshot> {
      const { snapshot: currentSnapshot, events, projection } = await projectFromStoredState();
      const snapshot: WorkgraphSnapshot = {
        version: 1,
        eventCount: currentSnapshot.compactedEventCount + events.length,
        compactedEventCount: currentSnapshot.compactedEventCount,
        lastEventId: events.at(-1)?.id ?? currentSnapshot.lastEventId,
        lastOccurredAt: events.at(-1)?.occurredAt ?? currentSnapshot.lastOccurredAt,
        projection,
      };
      await writeSnapshot(snapshot);
      return snapshot;
    },
    async compact(): Promise<WorkgraphSnapshot> {
      const snapshot = await this.rebuildSnapshot();
      const compactedSnapshot: WorkgraphSnapshot = {
        ...snapshot,
        compactedEventCount: snapshot.eventCount,
      };
      await writeSnapshot(compactedSnapshot);
      await mkdir(dirname(paths.workgraphEventsFile), { recursive: true });
      await writeFile(paths.workgraphEventsFile, "", "utf8");
      return compactedSnapshot;
    },
    async recoverSnapshotFromLog(): Promise<WorkgraphSnapshot> {
      const events = await list();
      const snapshot: WorkgraphSnapshot = {
        version: 1,
        eventCount: events.length,
        compactedEventCount: 0,
        lastEventId: events.at(-1)?.id,
        lastOccurredAt: events.at(-1)?.occurredAt,
        projection: projectWorkgraph(events),
      };
      await writeSnapshot(snapshot);
      return snapshot;
    },
  };
}
