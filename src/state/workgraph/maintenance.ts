import type { WorkgraphRepository } from "./file-backed-workgraph-repository.js";
import type { WorkgraphSnapshot } from "./snapshot.js";
import type { WorkgraphHealth, WorkgraphHealthPolicy } from "./health.js";

export interface WorkgraphMaintenanceResult {
  action: "none" | "compacted" | "recovery-required";
  before: WorkgraphHealth;
  after?: WorkgraphHealth;
  snapshot?: WorkgraphSnapshot;
}

export async function runWorkgraphMaintenance(
  repository: WorkgraphRepository,
  policy: WorkgraphHealthPolicy,
): Promise<WorkgraphMaintenanceResult> {
  const before = await repository.health(policy);
  if (before.status === "recovery-required") {
    return {
      action: "recovery-required",
      before,
    };
  }

  if (!before.compactRecommended) {
    return {
      action: "none",
      before,
    };
  }

  const snapshot = await repository.compact();
  const after = await repository.health(policy);
  return {
    action: "compacted",
    before,
    after,
    snapshot,
  };
}
