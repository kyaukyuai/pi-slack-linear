import { mergeSystemReply } from "../../lib/system-slack-reply.js";
import {
  runManagerSystemTurn,
  type ManagerAgentTurnResult,
} from "../../lib/pi-session.js";
import { commitManagerCommandProposals, type ManagerCommitResult } from "../../lib/manager-command-commit.js";
import type { AppConfig } from "../../lib/config.js";
import type { LinearCommandEnv, LinearIssue } from "../../lib/linear.js";
import type { SchedulerJob } from "../../lib/system-workspace.js";
import type { ManagerPolicy } from "../../state/manager-state-contract.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import type { ThreadPaths } from "../../lib/thread-workspace.js";

export interface HandleIssueCreatedWebhookArgs {
  config: AppConfig;
  paths: ThreadPaths;
  repositories: Pick<ManagerRepositories, "ownerMap" | "planning" | "followups" | "workgraph">;
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
  const lines = [
    "Linear issue created webhook context:",
    `- identifier: ${issue.identifier}`,
    `- issueId: ${issue.id}`,
    `- title: ${issue.title}`,
  ];

  if (issue.url) lines.push(`- url: ${issue.url}`);
  if (issue.state?.name) lines.push(`- stateName: ${issue.state.name}`);
  if (issue.state?.type) lines.push(`- stateType: ${issue.state.type}`);
  if (issue.assignee?.displayName || issue.assignee?.name) {
    lines.push(`- assignee: ${issue.assignee?.displayName ?? issue.assignee?.name}`);
  }
  if (issue.dueDate) lines.push(`- dueDate: ${issue.dueDate}`);
  if (issue.priorityLabel) lines.push(`- priorityLabel: ${issue.priorityLabel}`);
  if (issue.parent?.identifier) lines.push(`- parent: ${issue.parent.identifier}`);

  lines.push("");
  lines.push("Task:");
  lines.push("Decide whether this newly created issue needs immediate AI action through the existing proposal tools.");
  lines.push("If no immediate value exists, do nothing.");
  lines.push("");
  lines.push("Issue description:");
  lines.push(issue.description?.trim() || "(none)");
  return lines.join("\n");
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
    const agentResult = await runManagerSystemTurn(args.config, args.paths, {
      kind: "webhook-issue-created",
      channelId: args.policy.controlRoomChannelId,
      rootThreadTs: `webhook:${args.issue.identifier}`,
      messageTs: args.deliveryId,
      text: summarizeIssue(args.issue),
      currentDate: args.currentDate,
      runAtJst: args.runAtJst,
      metadata: {
        trigger: "linear-webhook",
        deliveryId: args.deliveryId,
        webhookId: args.webhookId ?? "",
        issueId: args.issue.id,
        issueIdentifier: args.issue.identifier,
      },
    });

    const commitResult = await commitManagerCommandProposals({
      config: args.config,
      repositories: args.repositories,
      proposals: agentResult.proposals,
      message: {
        channelId: args.policy.controlRoomChannelId,
        rootThreadTs: `webhook:${args.issue.identifier}`,
        messageTs: args.deliveryId,
        text: summarizeIssue(args.issue),
      },
      now: args.now,
      policy: args.policy,
      env: args.env,
      runSchedulerJobNow: args.runSchedulerJobNow,
    });

    const createdIssueIds = collectCreatedIssueIds(commitResult);
    if (commitResult.committed.length > 0) {
      return {
        status: "committed",
        agentResult,
        commitResult,
        createdIssueIds,
        reply: mergeSystemReply({
          agentReply: agentResult.reply,
          commitSummaries: commitResult.replySummaries,
          commitRejections: commitResult.rejected.map((entry) => entry.reason),
        }),
      };
    }

    if (commitResult.rejected.length > 0) {
      return {
        status: "failed",
        agentResult,
        commitResult,
        createdIssueIds,
        reason: commitResult.rejected.map((entry) => entry.reason).join(" / "),
        reply: mergeSystemReply({
          agentReply: agentResult.reply,
          commitSummaries: commitResult.replySummaries,
          commitRejections: commitResult.rejected.map((entry) => entry.reason),
        }),
      };
    }

    return {
      status: "noop",
      agentResult,
      commitResult,
      createdIssueIds,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      createdIssueIds: [],
      reason: message,
      reply: `新規 issue の webhook 自動処理に失敗しました。 ${message}`.trim(),
    };
  }
}
