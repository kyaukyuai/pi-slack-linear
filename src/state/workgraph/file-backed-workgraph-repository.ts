import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SystemPaths } from "../../lib/system-workspace.js";
import {
  createWorkgraphEvent,
  workgraphEventSchema,
  type WorkgraphEvent,
  type WorkgraphEventInput,
} from "./events.js";
import { projectWorkgraph, type WorkgraphProjection } from "./projection.js";

export interface WorkgraphRepository {
  list(): Promise<WorkgraphEvent[]>;
  append(events: WorkgraphEventInput | WorkgraphEventInput[]): Promise<WorkgraphEvent[]>;
  project(): Promise<WorkgraphProjection>;
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
    async project(): Promise<WorkgraphProjection> {
      return projectWorkgraph(await list());
    },
  };
}
