import { applyPersonalizationObservations, type PersonalizationObservationInput } from "../../lib/personalization-commit.js";
import { runPersonalizationExtractionTurn } from "../../lib/pi-session.js";
import type { AppConfig } from "../../lib/config.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { SystemPaths } from "../../lib/system-workspace.js";
import type { ThreadPaths } from "../../lib/thread-workspace.js";

export interface HandlePersonalizationArgs {
  config: AppConfig;
  systemPaths: SystemPaths;
  paths: ThreadPaths;
  repositories: Pick<ManagerRepositories, "personalization">;
  turnKind: "slack-message" | "manager-system";
  latestUserMessage: string;
  latestAssistantReply: string;
  committedCommands: string[];
  rejectedReasons: string[];
  currentDate: string;
  issueContext?: {
    issueId?: string;
    issueIdentifier?: string;
  };
  now: Date;
}

export interface HandlePersonalizationResult {
  observations: PersonalizationObservationInput[];
  promoted: string[];
  updatedFiles: Array<"agents" | "memory">;
}

function hasNonEmptyText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requiresProjectName(category: PersonalizationObservationInput["category"]): boolean {
  return category === "project-overview"
    || category === "members-and-roles"
    || category === "roadmap-and-milestones";
}

function isObservationUseful(observation: {
  kind: "operating_rule" | "preference_or_fact" | "ignore";
  source?: "explicit" | "inferred";
  category?: PersonalizationObservationInput["category"];
  projectName?: string;
  summary?: string;
  canonicalText?: string;
  confidence?: number;
}): observation is PersonalizationObservationInput {
  if (observation.kind === "ignore") {
    return false;
  }
  if (
    !observation.source
    || !observation.category
    || !hasNonEmptyText(observation.summary)
    || !hasNonEmptyText(observation.canonicalText)
  ) {
    return false;
  }
  if (requiresProjectName(observation.category) && !hasNonEmptyText(observation.projectName)) {
    return false;
  }
  if (typeof observation.confidence !== "number") {
    return false;
  }
  return true;
}

export async function handlePersonalizationUpdate(
  args: HandlePersonalizationArgs,
): Promise<HandlePersonalizationResult> {
  const extraction = await runPersonalizationExtractionTurn(args.config, args.paths, {
    turnKind: args.turnKind,
    latestUserMessage: args.latestUserMessage,
    latestAssistantReply: args.latestAssistantReply,
    committedCommands: args.committedCommands,
    rejectedReasons: args.rejectedReasons,
    currentDate: args.currentDate,
    issueContext: args.issueContext,
    taskKey: `${args.turnKind}-personalization`,
  });

  const observations = extraction.observations.filter(isObservationUseful);
  if (observations.length === 0) {
    return {
      observations: [],
      promoted: [],
      updatedFiles: [],
    };
  }

  const ledger = await args.repositories.personalization.load();
  const result = await applyPersonalizationObservations({
    paths: args.systemPaths,
    ledger,
    observations,
    now: args.now,
  });
  await args.repositories.personalization.save(result.ledger);

  return {
    observations,
    promoted: result.promoted.map((entry) => entry.canonicalText),
    updatedFiles: result.updatedFiles,
  };
}
