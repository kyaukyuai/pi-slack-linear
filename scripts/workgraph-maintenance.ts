import { resolve } from "node:path";
import { buildSystemPaths } from "../src/lib/system-workspace.js";
import { type WorkgraphHealthPolicy } from "../src/state/workgraph/health.js";
import { createFileBackedWorkgraphRepository } from "../src/state/workgraph/file-backed-workgraph-repository.js";

type Command = "health" | "snapshot" | "compact" | "recover";

function parseCommand(value: string | undefined): Command {
  if (value === "health" || value === "snapshot" || value === "compact" || value === "recover") {
    return value;
  }
  throw new Error("Usage: tsx scripts/workgraph-maintenance.ts <health|snapshot|compact|recover> [workspaceDir]");
}

function loadPolicy(): WorkgraphHealthPolicy {
  return {
    warnActiveLogEvents: Number(process.env.WORKGRAPH_HEALTH_WARN_ACTIVE_EVENTS ?? 200),
    autoCompactMaxActiveLogEvents: Number(process.env.WORKGRAPH_AUTO_COMPACT_MAX_ACTIVE_EVENTS ?? 500),
  };
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const workspaceDir = resolve(process.argv[3] ?? process.env.WORKSPACE_DIR ?? "./workspace");
  const repository = createFileBackedWorkgraphRepository(buildSystemPaths(workspaceDir));
  const policy = loadPolicy();

  if (command === "health") {
    const health = await repository.health(policy);
    process.stdout.write(`${JSON.stringify({
      command,
      workspaceDir,
      ...health,
    }, null, 2)}\n`);
    return;
  }

  const snapshot = command === "snapshot"
    ? await repository.rebuildSnapshot()
    : command === "compact"
      ? await repository.compact()
      : await repository.recoverSnapshotFromLog();

  process.stdout.write(`${JSON.stringify({
    command,
    workspaceDir,
    eventCount: snapshot.eventCount,
    compactedEventCount: snapshot.compactedEventCount,
    lastEventId: snapshot.lastEventId ?? null,
    lastOccurredAt: snapshot.lastOccurredAt ?? null,
    issueCount: Object.keys(snapshot.projection.issues).length,
    threadCount: Object.keys(snapshot.projection.threads).length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
