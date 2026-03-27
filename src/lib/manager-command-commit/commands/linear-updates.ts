import {
  addLinearComment,
  addLinearProgressComment,
  addLinearRelation,
  assignLinearIssue,
  getLinearIssue,
  markLinearIssueBlocked,
  updateManagedLinearIssue,
  type LinearIssue,
} from "../../linear.js";
import {
  formatCompactStatusReply,
  formatStatusReply,
} from "../../../orchestrators/updates/reply-format.js";
import { updateFollowupsWithIssueResponse } from "../../../orchestrators/updates/followup-state.js";
import { getSlackThreadContext } from "../../slack-context.js";
import { loadThreadQueryContinuation } from "../../query-continuation.js";
import { buildThreadPaths } from "../../thread-workspace.js";
import { buildWorkgraphThreadKey } from "../../../state/workgraph/events.js";
import { getThreadPlanningContext } from "../../../state/workgraph/queries.js";
import { recordFollowupTransitions, recordIssueSignals } from "../../../state/workgraph/recorder.js";
import type {
  AddCommentProposal,
  AddRelationProposal,
  AssignIssueProposal,
  ManagerCommandHandlerResult,
  SetIssueParentProposal,
  UpdateIssueStatusProposal,
} from "../contracts.js";
import type {
  CommitManagerCommandArgs,
  ManagerCommitMessageContext,
  ManagerCommitSystemContext,
} from "../contracts.js";
import { buildOccurredAt, isMessageContext, unique } from "../common.js";

function extractIssueIdentifiers(text: string): string[] {
  return unique(
    Array.from(text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g))
      .map((match) => match[1]?.trim())
      .filter(Boolean),
  );
}

interface CommitIssueHints {
  threadKey: string;
  explicitIssueIds: string[];
  recentIssueIds: string[];
  candidateIssueIds: string[];
  queryShownIssueIds: string[];
  latestFocusIssueId?: string;
  lastResolvedIssueId?: string;
}

async function collectCommitIssueHints(args: CommitManagerCommandArgs): Promise<CommitIssueHints> {
  const threadKey = buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs);
  const threadPaths = buildThreadPaths(args.config.workspaceDir, args.message.channelId, args.message.rootThreadTs);
  const explicitIssueIds = extractIssueIdentifiers(args.message.text);
  const recentThread = await getSlackThreadContext(
    args.config.workspaceDir,
    args.message.channelId,
    args.message.rootThreadTs,
    8,
  ).catch(() => undefined);
  const recentIssueIds = unique(
    (recentThread?.entries ?? [])
      .slice(-6)
      .flatMap((entry) => extractIssueIdentifiers(entry.text ?? "")),
  );
  const lastQueryContext = await loadThreadQueryContinuation(threadPaths).catch(() => undefined);
  const planningContext = await getThreadPlanningContext(args.repositories.workgraph, threadKey);
  const latestFocusIssueId = planningContext?.thread.latestFocusIssueId;
  const lastResolvedIssueId = planningContext?.latestResolvedIssue?.issueId ?? planningContext?.thread.lastResolvedIssueId;
  const queryShownIssueIds = unique(
    lastQueryContext?.shownIssueIds?.length
      ? lastQueryContext.shownIssueIds
      : (lastQueryContext?.issueIds ?? []),
  );
  const candidateIssueIds = unique([
    latestFocusIssueId,
    lastResolvedIssueId,
    planningContext?.parentIssue?.issueId,
    ...(planningContext?.childIssues.map((issue) => issue.issueId) ?? []),
    ...(planningContext?.linkedIssues.map((issue) => issue.issueId) ?? []),
    ...queryShownIssueIds,
  ]);

  return {
    threadKey,
    explicitIssueIds,
    recentIssueIds,
    candidateIssueIds,
    queryShownIssueIds,
    latestFocusIssueId,
    lastResolvedIssueId,
  };
}

async function validateUpdateIssueStatusProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssueStatusProposal,
): Promise<string | undefined> {
  const hints = await collectCommitIssueHints(args);

  if (hints.explicitIssueIds.length > 0 && !hints.explicitIssueIds.includes(proposal.issueId)) {
    return `このメッセージでは ${hints.explicitIssueIds.join(", ")} が明示されていますが、更新提案は ${proposal.issueId} でした。更新する issue ID を明記してください。`;
  }

  if (hints.explicitIssueIds.length === 0 && hints.recentIssueIds.length === 1) {
    const recentIssueId = hints.recentIssueIds[0];
    if (recentIssueId && recentIssueId !== proposal.issueId) {
      return `直近の会話では ${recentIssueId} を見ていましたが、更新提案は ${proposal.issueId} でした。更新する issue ID を明記してください。`;
    }
  }

  if (hints.candidateIssueIds.length === 0 && hints.explicitIssueIds.length === 0) {
    return "更新対象の issue をこの thread から特定できませんでした。`AIC-123` のように issue ID を添えてください。";
  }

  if (hints.candidateIssueIds.length === 1 && hints.candidateIssueIds[0] !== proposal.issueId) {
    return `この thread で確認できる更新対象は ${hints.candidateIssueIds[0]} ですが、更新提案は ${proposal.issueId} でした。更新する issue ID を明記してください。`;
  }

  if (
    hints.candidateIssueIds.length > 1
    && !hints.explicitIssueIds.includes(proposal.issueId)
    && proposal.issueId !== hints.latestFocusIssueId
    && proposal.issueId !== hints.lastResolvedIssueId
    && !hints.queryShownIssueIds.includes(proposal.issueId)
  ) {
    return "この thread には複数の issue が紐づいているため、どの issue を更新するか判断できませんでした。`AIC-123` のように issue ID を添えてください。";
  }

  return undefined;
}

function normalizeCompletedStateAlias(state: string | undefined): string | undefined {
  const normalized = state?.trim();
  if (!normalized) return normalized;
  const lowered = normalized.toLowerCase();
  if (
    lowered === "cancel"
    || lowered === "cancelled"
    || lowered === "canceled"
    || normalized === "キャンセル"
    || normalized === "削除"
    || normalized === "取り消し"
  ) {
    return "Canceled";
  }
  return normalized;
}

export function buildStatusSourceComment(
  message: ManagerCommitMessageContext | ManagerCommitSystemContext,
  heading: string,
): string {
  return [
    heading,
    `- channelId: ${message.channelId}`,
    `- rootThreadTs: ${message.rootThreadTs}`,
    `- sourceMessageTs: ${message.messageTs}`,
    "",
    message.text.trim(),
  ].join("\n");
}

export async function commitUpdateIssueStatusProposal(
  args: CommitManagerCommandArgs,
  proposal: UpdateIssueStatusProposal,
): Promise<ManagerCommandHandlerResult> {
  const rejectionReason = await validateUpdateIssueStatusProposal(args, proposal);
  if (rejectionReason) {
    return {
      proposal,
      reason: rejectionReason,
    };
  }

  const followups = await args.repositories.followups.load();
  const occurredAt = buildOccurredAt(args.now);
  const message = args.message;
  const normalizedCompletedState = proposal.signal === "completed"
    ? normalizeCompletedStateAlias(proposal.state)
    : proposal.state;
  const updatedIssues: LinearIssue[] = [];
  const blockedStateByIssueId = new Map<string, boolean>();
  const replyExtras: string[] = [];

  if (proposal.signal === "progress") {
    const progressComment = proposal.commentBody ?? buildStatusSourceComment(message, "## Progress source");
    if (proposal.dueDate || proposal.state) {
      updatedIssues.push(await updateManagedLinearIssue(
        {
          issueId: proposal.issueId,
          state: proposal.state,
          dueDate: proposal.dueDate,
          comment: progressComment.startsWith("## Progress update")
            ? progressComment
            : `## Progress update\n${progressComment.trim()}`,
        },
        args.env,
      ));
    } else {
      await addLinearProgressComment(
        proposal.issueId,
        progressComment,
        args.env,
      );
      updatedIssues.push(await getLinearIssue(proposal.issueId, args.env));
    }
  } else if (proposal.signal === "completed") {
    updatedIssues.push(await updateManagedLinearIssue(
      {
        issueId: proposal.issueId,
        state: normalizedCompletedState ?? "completed",
        dueDate: proposal.dueDate,
        comment: proposal.commentBody ?? buildStatusSourceComment(message, "## Completion source"),
      },
      args.env,
    ));
  } else {
    const blocked = await markLinearIssueBlocked(
      proposal.issueId,
      proposal.commentBody ?? buildStatusSourceComment(message, "## Blocked source"),
      args.env,
    );
    const blockedIssue = proposal.dueDate
      ? await updateManagedLinearIssue(
          {
            issueId: proposal.issueId,
            dueDate: proposal.dueDate,
          },
          args.env,
        )
      : blocked.issue;
    updatedIssues.push(blockedIssue);
    blockedStateByIssueId.set(proposal.issueId, blocked.blockedStateApplied);
  }

  if (proposal.dueDate) {
    const reflectedDueDate = updatedIssues
      .map((issue) => issue.dueDate)
      .find((dueDate): dueDate is string => Boolean(dueDate));
    if (reflectedDueDate) {
      replyExtras.push(`期限は ${reflectedDueDate} として反映しました。`);
    }
  }

  const nextFollowups = updateFollowupsWithIssueResponse(
    followups,
    updatedIssues,
    proposal.signal,
    message.text,
    args.now,
  );
  await args.repositories.followups.save(nextFollowups);
  await recordIssueSignals(args.repositories.workgraph, {
    occurredAt,
    source: {
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
    },
    textSnippet: message.text,
    updates: updatedIssues.map((issue) => ({
      issueId: issue.identifier,
      signal: proposal.signal,
      blockedStateApplied: blockedStateByIssueId.get(issue.identifier),
      dueDate: issue.dueDate ?? undefined,
    })),
  });
  await recordFollowupTransitions(args.repositories.workgraph, followups, nextFollowups, {
    occurredAt,
    source: {
      channelId: message.channelId,
      rootThreadTs: message.rootThreadTs,
      messageTs: message.messageTs,
    },
  });

  return {
    commandType: proposal.commandType,
    issueIds: updatedIssues.map((issue) => issue.identifier),
    summary: formatStatusReply(proposal.signal, updatedIssues, replyExtras),
    publicReply: updatedIssues.length === 1
      ? formatCompactStatusReply(proposal.signal, updatedIssues[0], replyExtras)
      : undefined,
  };
}

export async function commitAssignIssueProposal(
  args: CommitManagerCommandArgs,
  proposal: AssignIssueProposal,
): Promise<ManagerCommandHandlerResult> {
  const issue = await assignLinearIssue(proposal.issueId, proposal.assignee, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [issue.identifier],
    summary: `${issue.identifier} の担当を ${proposal.assignee} に更新しました。`,
  };
}

export async function commitAddCommentProposal(
  args: CommitManagerCommandArgs,
  proposal: AddCommentProposal,
): Promise<ManagerCommandHandlerResult> {
  await addLinearComment(proposal.issueId, proposal.body, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId],
    summary: `${proposal.issueId} にコメントを追加しました。`,
  };
}

export async function commitAddRelationProposal(
  args: CommitManagerCommandArgs,
  proposal: AddRelationProposal,
): Promise<ManagerCommandHandlerResult> {
  await addLinearRelation(proposal.issueId, proposal.relationType, proposal.relatedIssueId, args.env);
  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId, proposal.relatedIssueId],
    summary: `${proposal.issueId} と ${proposal.relatedIssueId} の依存関係を更新しました。`,
  };
}

export async function commitSetIssueParentProposal(
  args: CommitManagerCommandArgs,
  proposal: SetIssueParentProposal,
): Promise<ManagerCommandHandlerResult> {
  if (proposal.issueId === proposal.parentIssueId) {
    return {
      proposal,
      reason: "親 issue と子 issue に同じ issue ID は使えません。親子関係を確認してください。",
    };
  }

  const updatedIssue = await updateManagedLinearIssue(
    {
      issueId: proposal.issueId,
      parent: proposal.parentIssueId,
    },
    args.env,
  );

  await args.repositories.workgraph.append([
    {
      type: "issue.parent_updated",
      occurredAt: buildOccurredAt(args.now),
      threadKey: buildWorkgraphThreadKey(args.message.channelId, args.message.rootThreadTs),
      sourceChannelId: args.message.channelId,
      sourceThreadTs: args.message.rootThreadTs,
      sourceMessageTs: args.message.messageTs,
      issueId: proposal.issueId,
      parentIssueId: proposal.parentIssueId,
      title: updatedIssue.title,
    },
  ]);

  return {
    commandType: proposal.commandType,
    issueIds: [proposal.issueId, proposal.parentIssueId],
    summary: `${proposal.issueId} を ${proposal.parentIssueId} の子 task として反映しました。`,
  };
}
