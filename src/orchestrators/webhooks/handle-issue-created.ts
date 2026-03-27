import { mergeSystemReply } from "../../lib/system-slack-reply.js";
import { handlePersonalizationUpdate } from "../personalization/handle-personalization.js";
import { buildSlackVisibleLlmFailureNotice } from "../../lib/llm-failure.js";
import {
  runManagerSystemTurn,
  type ManagerAgentTurnResult,
} from "../../lib/pi-session.js";
import {
  commitManagerCommandProposals,
  type ManagerCommandProposal,
  type ManagerCommitResult,
} from "../../lib/manager-command-commit.js";
import type { AppConfig } from "../../lib/config.js";
import {
  getLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
} from "../../lib/linear.js";
import type { SchedulerJob } from "../../lib/system-workspace.js";
import { buildSystemPaths } from "../../lib/system-workspace.js";
import type { ManagerPolicy } from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { ThreadPaths } from "../../lib/thread-workspace.js";
import {
  WEBHOOK_INITIAL_PROPOSAL_DEDUPE_KEY_PREFIX,
  hasWebhookInitialProposalComment,
  normalizeWebhookInitialProposalCommentBody,
} from "./initial-proposal-comment.js";

export interface HandleIssueCreatedWebhookArgs {
  config: AppConfig;
  paths: ThreadPaths;
  repositories: Pick<ManagerRepositories, "ownerMap" | "planning" | "followups" | "workgraph" | "personalization" | "notionPages">;
  policy: ManagerPolicy;
  issue: LinearIssue;
  deliveryId: string;
  webhookId?: string;
  now: Date;
  env: LinearCommandEnv;
  runSchedulerJobNow?: (job: SchedulerJob) => Promise<{
    status: "ok" | "error";
    persistedSummary: string;
    commitSummary?: string;
    executedAt?: string;
  }>;
  currentDate: string;
  runAtJst: string;
}

export interface HandleIssueCreatedWebhookResult {
  status: "noop" | "committed" | "failed";
  agentResult?: ManagerAgentTurnResult;
  commitResult?: ManagerCommitResult;
  reply?: string;
  reason?: string;
  createdIssueIds: string[];
}

function summarizeIssue(issue: LinearIssue): string {
  const creator = issue.creator?.displayName ?? issue.creator?.name;
  const assignee = issue.assignee?.displayName ?? issue.assignee?.name;
  const labelNames = (issue.labels ?? []).map((label) => label.name?.trim()).filter(Boolean) as string[];
  const relationCount = (issue.relations?.length ?? 0) + (issue.inverseRelations?.length ?? 0);
  const description = issue.description?.trim() || "";
  const lines = [
    "Linear issue created webhook context:",
    `- identifier: ${issue.identifier}`,
    `- issueId: ${issue.id}`,
    `- title: ${issue.title}`,
  ];

  if (issue.url) lines.push(`- url: ${issue.url}`);
  if (issue.createdAt) lines.push(`- createdAt: ${issue.createdAt}`);
  if (issue.state?.name) lines.push(`- stateName: ${issue.state.name}`);
  if (issue.state?.type) lines.push(`- stateType: ${issue.state.type}`);
  if (creator) lines.push(`- creator: ${creator}`);
  if (assignee) lines.push(`- assignee: ${assignee}`);
  if (issue.dueDate) lines.push(`- dueDate: ${issue.dueDate}`);
  if (issue.priorityLabel) lines.push(`- priorityLabel: ${issue.priorityLabel}`);
  if (issue.parent?.identifier) lines.push(`- parent: ${issue.parent.identifier}`);
  if (labelNames.length > 0) lines.push(`- labels: ${labelNames.join(", ")}`);
  lines.push(`- childCount: ${issue.children?.length ?? 0}`);
  lines.push(`- relationCount: ${relationCount}`);
  lines.push(`- commentCount: ${issue.comments?.length ?? 0}`);
  lines.push(`- descriptionPresent: ${description ? "yes" : "no"}`);
  if (description) lines.push(`- descriptionLength: ${description.length}`);

  lines.push("");
  lines.push("Task:");
  lines.push("Default to adding one best-effort initial proposal comment to this issue.");
  lines.push("Use add_comment only. No status changes, assignment changes, relations, or child issue creation are allowed here.");
  lines.push("If an initial proposal comment already exists, do nothing.");
  lines.push("Do not ask follow-up questions in webhook mode.");
  lines.push("");
  lines.push("Issue description:");
  lines.push(description || "(none)");
  return lines.join("\n");
}

function selectWebhookCommentProposal(
  issueIdentifier: string,
  proposals: ManagerCommandProposal[],
): Extract<ManagerCommandProposal, { commandType: "add_comment" }> | undefined {
  const selected = proposals.find((proposal): proposal is Extract<ManagerCommandProposal, { commandType: "add_comment" }> => (
    proposal.commandType === "add_comment" && proposal.issueId === issueIdentifier
  ));
  if (!selected) {
    return undefined;
  }
  return {
    ...selected,
    body: normalizeWebhookInitialProposalCommentBody(selected.body),
    dedupeKeyCandidate: selected.dedupeKeyCandidate ?? `${WEBHOOK_INITIAL_PROPOSAL_DEDUPE_KEY_PREFIX}:${issueIdentifier}`,
  };
}

function collectCreatedIssueIds(commitResult: ManagerCommitResult): string[] {
  return commitResult.committed
    .filter((entry) => entry.commandType === "create_issue" || entry.commandType === "create_issue_batch")
    .flatMap((entry) => entry.issueIds);
}

export async function handleIssueCreatedWebhook(
  args: HandleIssueCreatedWebhookArgs,
): Promise<HandleIssueCreatedWebhookResult> {
  try {
    const hydratedIssue = await getLinearIssue(args.issue.identifier, args.env, undefined, { includeComments: true })
      .catch(() => args.issue);
    if (hasWebhookInitialProposalComment(hydratedIssue)) {
      return {
        status: "noop",
        createdIssueIds: [],
        reason: "initial proposal comment already exists",
      };
    }

    const webhookSummary = summarizeIssue(hydratedIssue);
    const updatePersonalization = async (reply: string, commitResult: ManagerCommitResult): Promise<void> => {
      try {
        await handlePersonalizationUpdate({
          config: args.config,
          systemPaths: buildSystemPaths(args.config.workspaceDir),
          paths: args.paths,
          repositories: args.repositories,
          turnKind: "manager-system",
          latestUserMessage: webhookSummary,
          latestAssistantReply: reply,
          committedCommands: commitResult.committed.map((entry) => entry.commandType),
          rejectedReasons: commitResult.rejected.map((entry) => entry.reason),
          currentDate: args.currentDate,
          issueContext: {
            issueId: hydratedIssue.id,
            issueIdentifier: hydratedIssue.identifier,
          },
          now: args.now,
        });
      } catch {
        // webhook automation stays silent if personalization extraction fails
      }
    };

    const agentResult = await runManagerSystemTurn(args.config, args.paths, {
      kind: "webhook-issue-created",
      channelId: args.policy.controlRoomChannelId,
      rootThreadTs: `webhook:${hydratedIssue.identifier}`,
      messageTs: args.deliveryId,
      text: webhookSummary,
      currentDate: args.currentDate,
      runAtJst: args.runAtJst,
      metadata: {
        trigger: "linear-webhook",
        deliveryId: args.deliveryId,
        webhookId: args.webhookId ?? "",
        issueId: hydratedIssue.id,
        issueIdentifier: hydratedIssue.identifier,
      },
    });
    const webhookCommentProposal = selectWebhookCommentProposal(hydratedIssue.identifier, agentResult.proposals);
    if (agentResult.proposals.length > 0 && !webhookCommentProposal) {
      const reason = `webhook issue-created では ${hydratedIssue.identifier} への add_comment のみ自動実行できます。`;
      return {
        status: "failed",
        agentResult,
        createdIssueIds: [],
        reason,
        reply: reason,
      };
    }

    const commitResult = await commitManagerCommandProposals({
      config: args.config,
      repositories: args.repositories,
      proposals: webhookCommentProposal ? [webhookCommentProposal] : [],
      message: {
        channelId: args.policy.controlRoomChannelId,
        rootThreadTs: `webhook:${hydratedIssue.identifier}`,
        messageTs: args.deliveryId,
        text: webhookSummary,
      },
      now: args.now,
      policy: args.policy,
      env: args.env,
      runSchedulerJobNow: args.runSchedulerJobNow,
    });

    const createdIssueIds = collectCreatedIssueIds(commitResult);
    if (commitResult.committed.length > 0) {
      const reply = mergeSystemReply({
        agentReply: agentResult.reply,
        commitSummaries: commitResult.replySummaries,
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
      });
      await updatePersonalization(reply, commitResult);
      return {
        status: "committed",
        agentResult,
        commitResult,
        createdIssueIds,
        reply,
      };
    }

    if (commitResult.rejected.length > 0) {
      const reply = mergeSystemReply({
        agentReply: agentResult.reply,
        commitSummaries: commitResult.replySummaries,
        commitRejections: commitResult.rejected.map((entry) => entry.reason),
      });
      await updatePersonalization(reply, commitResult);
      return {
        status: "failed",
        agentResult,
        commitResult,
        createdIssueIds,
        reason: commitResult.rejected.map((entry) => entry.reason).join(" / "),
        reply,
      };
    }

    await updatePersonalization(agentResult.reply, commitResult);

    return {
      status: "noop",
      agentResult,
      commitResult,
      createdIssueIds,
      reason: agentResult.taskExecutionDecision?.summary ?? "no executable manager action",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      createdIssueIds: [],
      reason: message,
      reply: buildSlackVisibleLlmFailureNotice(error) ?? `処理に失敗しました。 ${message}`.trim(),
    };
  }
}
