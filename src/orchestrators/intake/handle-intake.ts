import {
  addLinearComment,
  addLinearRelation,
  createManagedLinearIssue,
  createManagedLinearIssueBatch,
  getLinearIssue,
  searchLinearIssues,
  updateManagedLinearIssue,
  type LinearCommandEnv,
  type LinearIssue,
} from "../../lib/linear.js";
import {
  type ManagerPolicy,
  type PlanningLedgerEntry,
} from "../../state/manager-state-contract.js";
import {
  runResearchSynthesisTurn,
  runTaskPlanningTurn,
  type ResearchSynthesisResult,
} from "../../lib/pi-session.js";
import { getRecentChannelContext, getSlackThreadContext } from "../../lib/slack-context.js";
import { buildThreadPaths } from "../../lib/thread-workspace.js";
import { webFetchUrl, webSearchFetch } from "../../lib/web-research.js";
import type { AppConfig } from "../../lib/config.js";
import type { ManagerRepositories } from "../../state/repositories/file-backed-manager-repositories.js";
import {
  buildWorkgraphThreadKey,
} from "../../state/workgraph/events.js";
import {
  findExistingThreadIntakeByFingerprint,
  getThreadPlanningContext,
  type PendingClarificationContext,
} from "../../state/workgraph/queries.js";
import {
  buildPlanningChildRecord,
  recordIntakeClarificationRequested,
  recordIntakeCorrectedExisting,
  recordIntakeLinkedExisting,
  recordPlanningOutcome,
} from "../../state/workgraph/recorder.js";
import {
  buildCorrectedSlackSourceText,
  buildExecutionIssueDescription,
  compactLinearIssues,
  formatSourceComment,
  formatCorrectedExistingIssueReply,
  formatExistingIssueReply,
  formatSlackContextSummary,
  formatRelatedIssuesSummary,
  formatWebSummary,
  buildFallbackResearchSynthesis,
  buildResearchIssueDescription,
  buildResearchComment,
  buildResearchSlackSummary,
  formatAutonomousCreateReply,
  formatIssueReference,
} from "./formatting.js";
import {
  chooseExistingResearchParent,
  chooseOwner,
  filterResearchNextActions,
} from "./planning-support.js";

export interface IntakeMessage {
  channelId: string;
  rootThreadTs: string;
  messageTs: string;
  userId: string;
  text: string;
}

export interface IntakeHandleResult {
  handled: boolean;
  reply?: string;
}

export interface IntakeHelpers {
  toJstDate(date: Date): Date;
  fingerprintText(text: string): string;
  nowIso(now: Date): string;
}

export interface HandleIntakeRequestArgs {
  config: AppConfig;
  repositories: Pick<ManagerRepositories, "ownerMap" | "planning" | "workgraph">;
  message: IntakeMessage;
  now: Date;
  policy: ManagerPolicy;
  pendingClarification?: PendingClarificationContext;
  originalRequestText: string;
  requestMessage: IntakeMessage;
  env: LinearCommandEnv;
  helpers: IntakeHelpers;
}

type SlackIssueReference = Pick<LinearIssue, "identifier" | "title"> & { url?: string | null };

function toSlackIssueReference(
  issue: Pick<LinearIssue, "identifier" | "title" | "url"> | { issueId: string; title?: string },
): SlackIssueReference {
  return {
    identifier: "identifier" in issue ? issue.identifier : issue.issueId,
    title: issue.title ?? ("identifier" in issue ? issue.identifier : issue.issueId),
    url: "url" in issue ? issue.url : undefined,
  };
}

function pickReusableDuplicate(
  duplicates: LinearIssue[],
  preferredParentIssueId?: string,
): LinearIssue | undefined {
  const candidates = preferredParentIssueId
    ? duplicates.filter((issue) => issue.identifier !== preferredParentIssueId)
    : duplicates;
  if (candidates.length === 0) return undefined;

  if (preferredParentIssueId) {
    const alreadyAttached = candidates.filter((issue) => issue.parent?.identifier === preferredParentIssueId);
    if (alreadyAttached.length === 1) {
      return alreadyAttached[0];
    }
    if (alreadyAttached.length > 1) {
      return undefined;
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

function isClosedLinearIssue(issue: LinearIssue): boolean {
  const stateName = issue.state?.name?.trim().toLowerCase();
  return issue.state?.type === "completed"
    || issue.state?.type === "canceled"
    || stateName === "done"
    || stateName === "canceled"
    || stateName === "cancelled";
}

export async function handleIntakeRequest({
  config,
  repositories,
  message,
  now,
  policy,
  pendingClarification,
  originalRequestText,
  requestMessage,
  env,
  helpers,
}: HandleIntakeRequestArgs): Promise<IntakeHandleResult> {
  const ownerMap = await repositories.ownerMap.load();
  const planningLedger = await repositories.planning.load();
  const occurredAt = helpers.nowIso(now);
  const workgraphSource = {
    channelId: requestMessage.channelId,
    rootThreadTs: requestMessage.rootThreadTs,
    messageTs: pendingClarification?.sourceMessageTs ?? requestMessage.messageTs,
  };

  const fingerprint = pendingClarification?.messageFingerprint ?? helpers.fingerprintText(requestMessage.text);
  const existingThreadIntake = await findExistingThreadIntakeByFingerprint(
    repositories.workgraph,
    buildWorkgraphThreadKey(requestMessage.channelId, requestMessage.rootThreadTs),
    fingerprint,
  );

  if (existingThreadIntake) {
    const linkedIssues = Array.from(new Set(
      [
        existingThreadIntake.parentIssueId,
        ...existingThreadIntake.childIssueIds,
        ...existingThreadIntake.linkedIssueIds,
      ].filter(Boolean),
    )) as string[];
    return {
      handled: true,
      reply: linkedIssues.length > 0
        ? ["この依頼は既に取り込まれています。", ...linkedIssues.map((issueId) => `- ${issueId}`)].join("\n")
        : "この依頼は既に取り込まれています。",
    };
  }

  const planningContext = await getThreadPlanningContext(
    repositories.workgraph,
    buildWorkgraphThreadKey(requestMessage.channelId, requestMessage.rootThreadTs),
  ).catch(() => undefined);

  const planningPaths = buildThreadPaths(config.workspaceDir, requestMessage.channelId, requestMessage.rootThreadTs);
  const taskPlan = await runTaskPlanningTurn(
    config,
    planningPaths,
    {
      channelId: requestMessage.channelId,
      rootThreadTs: requestMessage.rootThreadTs,
      originalRequest: originalRequestText,
      latestUserMessage: message.text,
      combinedRequest: requestMessage.text,
      clarificationQuestion: pendingClarification?.clarificationQuestion,
      currentDate: helpers.toJstDate(now).toISOString().slice(0, 10),
      threadContext: {
        latestResolvedIssueId: planningContext?.latestResolvedIssue?.issueId ?? planningContext?.thread.lastResolvedIssueId,
        latestResolvedIssueTitle: planningContext?.latestResolvedIssue?.title,
        latestResolvedIssueLastStatus: planningContext?.latestResolvedIssue?.lastStatus,
        threadIntakeStatus: planningContext?.thread.intakeStatus,
        threadChildIssueIds: planningContext?.thread.childIssueIds,
        threadParentIssueId: planningContext?.thread.parentIssueId,
      },
      taskKey: `${requestMessage.channelId}-${requestMessage.rootThreadTs}-task-plan`,
    },
  );

  if (taskPlan.action === "clarify") {
    await recordIntakeClarificationRequested(repositories.workgraph, {
      occurredAt,
      source: workgraphSource,
      messageFingerprint: fingerprint,
      clarificationQuestion: taskPlan.clarificationQuestion,
      clarificationReasons: taskPlan.clarificationReasons,
      originalText: requestMessage.text,
    });
    return {
      handled: true,
      reply: taskPlan.clarificationQuestion,
    };
  }

  if (taskPlan.action === "update_existing") {
    const correctionTargetIsSafe = planningContext?.thread.intakeStatus === "created"
      && !planningContext.thread.parentIssueId
      && planningContext.thread.childIssueIds.length === 1
      && planningContext.latestResolvedIssue?.issueId === taskPlan.targetIssueId
      && !planningContext.latestResolvedIssue?.lastStatus;
    if (!correctionTargetIsSafe) {
      return {
        handled: true,
        reply: "訂正対象の既存 issue を 1 件に安全に確定できないため、対象 issue ID を明示してください。",
      };
    }
    const targetIssue = await getLinearIssue(taskPlan.targetIssueId, env);
    if (isClosedLinearIssue(targetIssue)) {
      return {
        handled: true,
        reply: "訂正対象の issue はすでに完了または取消済みのため、自動では修正しません。必要なら新規 issue として作成するか、対象 issue ID を指定してください。",
      };
    }

    const explicitOwner = taskPlan.assigneeHint
      ? chooseOwner(taskPlan.assigneeHint, ownerMap)
      : undefined;
    const correctedIssue = await updateManagedLinearIssue(
      {
        issueId: taskPlan.targetIssueId,
        title: taskPlan.title,
        description: buildExecutionIssueDescription(buildCorrectedSlackSourceText(originalRequestText, message.text)),
        dueDate: taskPlan.dueDate,
        assignee: explicitOwner?.resolution === "mapped" ? explicitOwner.entry.linearAssignee : undefined,
      },
      env,
    );
    await addLinearComment(correctedIssue.identifier, formatSourceComment(requestMessage, "single-issue-correction"), env);
    await recordIntakeCorrectedExisting(repositories.workgraph, {
      occurredAt,
      source: workgraphSource,
      messageFingerprint: fingerprint,
      correctedIssueId: correctedIssue.identifier,
      originalText: requestMessage.text,
    });
    return {
      handled: true,
      reply: formatCorrectedExistingIssueReply(correctedIssue),
    };
  }

  const planningReason = taskPlan.planningReason;
  const planningTitle = taskPlan.parentTitle ?? taskPlan.children[0]?.title;
  if (!planningTitle) {
    throw new Error("Task planner returned no planning title");
  }
  const primaryTitle = planningTitle;
  const research = planningReason === "research-first" || taskPlan.children.some((child) => child.kind === "research");
  const globalDueDate = taskPlan.parentDueDate;
  const threadPlanningContext = planningReason === "single-issue" ? planningContext : undefined;
  const threadParentIssue = !research && planningReason === "single-issue" && threadPlanningContext?.parentIssue
    ? toSlackIssueReference(threadPlanningContext.parentIssue)
    : undefined;
  const duplicates = await searchLinearIssues(
    {
      query: planningTitle.slice(0, 32),
      limit: 5,
    },
    env,
  );

  if (duplicates.length > 0 && !research) {
    const reusableDuplicate = pickReusableDuplicate(duplicates, threadParentIssue?.identifier);
    if (reusableDuplicate) {
      const preferredParentIssueId = threadParentIssue?.identifier;
      const attachedToParent = Boolean(
        preferredParentIssueId
        && reusableDuplicate.identifier !== preferredParentIssueId
        && reusableDuplicate.parent?.identifier !== preferredParentIssueId,
      );
      const reusedIssue = attachedToParent && preferredParentIssueId
        ? await updateManagedLinearIssue(
            {
              issueId: reusableDuplicate.identifier,
              parent: preferredParentIssueId,
            },
            env,
          )
        : reusableDuplicate;
      await recordIntakeLinkedExisting(repositories.workgraph, {
        occurredAt,
        source: workgraphSource,
        messageFingerprint: fingerprint,
        linkedIssueIds: [reusedIssue.identifier],
        lastResolvedIssueId: reusedIssue.identifier,
        originalText: requestMessage.text,
      });
      return {
        handled: true,
        reply: formatExistingIssueReply(
          [reusedIssue],
          threadParentIssue
            ? {
                parent: threadParentIssue,
                attachedToParent,
              }
            : undefined,
        ),
      };
    }
    await recordIntakeLinkedExisting(repositories.workgraph, {
      occurredAt,
      source: workgraphSource,
      messageFingerprint: fingerprint,
      linkedIssueIds: duplicates.map((issue) => issue.identifier),
      lastResolvedIssueId: duplicates.length === 1 ? duplicates[0]?.identifier : undefined,
      originalText: requestMessage.text,
    });
    return {
      handled: true,
      reply: formatExistingIssueReply(duplicates),
    };
  }

  const existingResearchParent = research ? chooseExistingResearchParent(duplicates, planningTitle) : undefined;
  const needsNewParent = Boolean(taskPlan.parentTitle) && !existingResearchParent;
  const usedFallbackOwners = new Set<string>();
  const parentOwner = needsNewParent ? chooseOwner(planningTitle, ownerMap) : undefined;
  if (parentOwner?.resolution === "fallback") {
    usedFallbackOwners.add(parentOwner.entry.id);
  }

  const plannedChildren = taskPlan.children.map((child) => {
    const owner = chooseOwner(child.assigneeHint ?? child.title, ownerMap);
    if (!child.assigneeHint && owner.resolution === "fallback") {
      usedFallbackOwners.add(owner.entry.id);
    }
    const childDueDate = child.dueDate ?? globalDueDate;

    return {
      childText: child.title,
      title: child.title,
      description: child.kind === "research"
        ? [
            "## Slack source",
            requestMessage.text,
            "",
            "## 調べた範囲",
            "- ここに調査対象を書く",
            "",
            "## 分かったこと",
            "- ここに調査結果を書く",
            "",
            "## 未確定事項",
            "- ここに未確定事項を書く",
            "",
            "## 次アクション",
            "- ここに次アクションを書く",
          ].join("\n")
        : buildExecutionIssueDescription(requestMessage.text),
      dueDate: childDueDate,
      assignee: child.assigneeHint ?? owner.entry.linearAssignee,
      priority: childDueDate ? 2 : undefined,
      isResearch: child.kind === "research",
    };
  });

  let createdParent: LinearIssue | undefined;
  let parent = existingResearchParent;
  let createdChildren: LinearIssue[] = [];
  let researchChild: LinearIssue | undefined;

  if (needsNewParent && plannedChildren.length >= 2) {
    const batch = await createManagedLinearIssueBatch(
      {
        parent: {
          title: planningTitle,
          description: [
            "## 目的",
            planningTitle,
            "",
            "## 完了条件",
            "- Slack の依頼を親 issue として管理する",
            "- 実行子 issue で前進できる状態にする",
          ].join("\n"),
          assignee: parentOwner?.entry.linearAssignee,
          dueDate: globalDueDate,
          priority: globalDueDate ? 2 : undefined,
        },
        children: plannedChildren.map((child) => ({
          title: child.title,
          description: child.description,
          dueDate: child.dueDate,
          assignee: child.assignee,
          priority: child.priority,
        })),
      },
      env,
    );
    createdParent = batch.parent;
    parent = batch.parent;
    createdChildren = compactLinearIssues(batch.children);
    if (createdChildren.length !== plannedChildren.length) {
      throw new Error(`Linear batch create returned ${createdChildren.length}/${plannedChildren.length} children`);
    }
    const researchIndex = plannedChildren.findIndex((child) => child.isResearch);
    researchChild = researchIndex >= 0 ? createdChildren[researchIndex] : undefined;
  } else {
    createdParent = needsNewParent
      ? await createManagedLinearIssue(
          {
            title: planningTitle,
            description: [
              "## 目的",
              planningTitle,
              "",
              "## 完了条件",
              "- Slack の依頼を親 issue として管理する",
              "- 実行子 issue で前進できる状態にする",
            ].join("\n"),
            assignee: parentOwner?.entry.linearAssignee,
            dueDate: globalDueDate,
            priority: globalDueDate ? 2 : undefined,
          },
          env,
        )
      : undefined;
    parent = existingResearchParent ?? createdParent;

    for (const child of plannedChildren) {
      const createdChild = await createManagedLinearIssue(
        {
          title: child.title,
          description: child.description,
          dueDate: child.dueDate,
          parent: parent?.identifier ?? threadParentIssue?.identifier,
          assignee: child.assignee,
          priority: child.priority,
        },
        env,
      );

      if (!createdChild) {
        throw new Error(`Linear create returned no issue for child: ${child.title}`);
      }

      createdChildren.push(createdChild);
      if (child.isResearch) {
        researchChild = createdChild;
      }
    }
  }

  for (const child of createdChildren) {
    await addLinearComment(child.identifier, formatSourceComment(requestMessage, planningReason), env);
  }

  if (parent) {
    await addLinearComment(parent.identifier, formatSourceComment(requestMessage, planningReason), env);
  }

  if (parent && createdChildren.length > 1) {
    for (let index = 1; index < createdChildren.length; index += 1) {
      await addLinearRelation(createdChildren[index - 1].identifier, "blocks", createdChildren[index].identifier, env);
    }
  }

  if (researchChild) {
    const slackThreadContext = await getSlackThreadContext(config.workspaceDir, requestMessage.channelId, requestMessage.rootThreadTs).catch(() => ({
      channelId: requestMessage.channelId,
      rootThreadTs: requestMessage.rootThreadTs,
      entries: [],
    }));
    const recentChannelContexts = await getRecentChannelContext(config.workspaceDir, requestMessage.channelId, 3, 6).catch(() => []);
    const relatedIssues = (await searchLinearIssues(
      {
        query: primaryTitle.slice(0, 32),
        limit: 5,
      },
      env,
    ).catch(() => [])).filter((issue) => issue.identifier !== researchChild?.identifier && issue.identifier !== parent?.identifier);
    const searchResults = await webSearchFetch(primaryTitle, 3).catch(() => []);
    const fetchedPages: Awaited<ReturnType<typeof webFetchUrl>>[] = [];
    for (const result of searchResults.slice(0, 2)) {
      try {
        fetchedPages.push(await webFetchUrl(result.url));
      } catch {
        // Ignore fetch failures for individual pages and keep the rest of the research summary.
      }
    }

    const existingTitles = [parent?.title, ...createdChildren.map((issue) => issue.title)].filter(Boolean) as string[];
    const researchPaths = buildThreadPaths(config.workspaceDir, requestMessage.channelId, requestMessage.rootThreadTs);
    const rawResearchSynthesis = await runResearchSynthesisTurn(
      config,
      researchPaths,
      {
        channelId: requestMessage.channelId,
        rootThreadTs: requestMessage.rootThreadTs,
        taskTitle: planningTitle,
        sourceMessage: requestMessage.text,
        slackThreadSummary: formatSlackContextSummary(slackThreadContext.entries),
        recentChannelSummary: recentChannelContexts.length > 0
          ? recentChannelContexts
            .slice(0, 3)
            .map((context) => `- ${context.rootThreadTs}: ${context.entries.slice(-1)[0]?.text.replace(/\s+/g, " ").slice(0, 120) ?? "(no messages)"}`)
            .join("\n")
          : "- 直近 thread 文脈は取得できませんでした。",
        relatedIssuesSummary: formatRelatedIssuesSummary(relatedIssues),
        webSummary: formatWebSummary(searchResults, fetchedPages),
        taskKey: researchChild.identifier,
      },
    ).catch(() => buildFallbackResearchSynthesis({
      slackThreadEntries: slackThreadContext.entries,
      relatedIssues,
      searchResults,
    }));
    const researchSynthesis: ResearchSynthesisResult = {
      ...rawResearchSynthesis,
      nextActions: filterResearchNextActions(rawResearchSynthesis.nextActions, existingTitles, policy),
    };

    await updateManagedLinearIssue(
      {
        issueId: researchChild.identifier,
        description: buildResearchIssueDescription({
          sourceMessage: requestMessage,
          synthesis: researchSynthesis,
        }),
      },
      env,
    );

    await addLinearComment(
      researchChild.identifier,
      buildResearchComment({
        sourceMessage: requestMessage,
        slackThreadEntries: slackThreadContext.entries,
        recentChannelContexts,
        relatedIssues,
        searchResults,
        fetchedPages,
        synthesis: researchSynthesis,
      }),
      env,
    );

    const followupChildren: LinearIssue[] = [];
    if (policy.autoPlan && researchSynthesis.nextActions.length >= policy.researchAutoPlanMinActions) {
      const parentAssignee = parent?.assignee?.displayName ?? parent?.assignee?.name;
      for (const nextAction of researchSynthesis.nextActions.slice(0, policy.researchAutoPlanMaxChildren)) {
        if (nextAction.title.trim().length < 6) {
          continue;
        }
        const owner = chooseOwner(nextAction.ownerHint ?? nextAction.title, ownerMap);
        if (owner.resolution === "fallback") {
          usedFallbackOwners.add(owner.entry.id);
        }

        const followupChild = await createManagedLinearIssue(
          {
            title: nextAction.title,
            description: [
              "## Research source",
              formatIssueReference(researchChild),
              "",
              "## Purpose",
              nextAction.purpose || "調査結果を踏まえて実行可能な状態にする",
              "",
              "## Slack source",
              requestMessage.text,
              "",
              "## 完了条件",
              "- 調査結果を踏まえて実行可能な状態にする",
            ].join("\n"),
            parent: parent?.identifier,
            assignee: owner.resolution === "mapped" ? owner.entry.linearAssignee : parentAssignee ?? owner.entry.linearAssignee,
            dueDate: researchChild.dueDate ?? parent?.dueDate ?? undefined,
            priority: (researchChild.dueDate ?? parent?.dueDate) ? 2 : undefined,
          },
          env,
        );
        followupChildren.push(followupChild);
      }
    }

    const allCreatedChildren = [...createdChildren, ...followupChildren];

    const planningEntry: PlanningLedgerEntry = {
      sourceThread: `${message.channelId}:${message.rootThreadTs}`,
      parentIssueId: parent?.identifier,
      generatedChildIssueIds: allCreatedChildren.map((issue) => issue.identifier),
      planningReason,
      ownerResolution: usedFallbackOwners.size > 0 ? "fallback" : "mapped",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    await repositories.planning.save([...planningLedger, planningEntry]);
    await recordPlanningOutcome(repositories.workgraph, {
      occurredAt,
      source: workgraphSource,
      messageFingerprint: fingerprint,
      parentIssue: createdParent
        ? {
            issueId: createdParent.identifier,
            title: createdParent.title,
            dueDate: globalDueDate,
            assignee: parentOwner?.entry.linearAssignee,
          }
        : undefined,
      parentIssueId: parent?.identifier,
      childIssues: [
        ...createdChildren.map((issue, index) => buildPlanningChildRecord(
          issue,
          plannedChildren[index]?.isResearch ? "research" : "execution",
          {
            dueDate: plannedChildren[index]?.dueDate,
            assignee: plannedChildren[index]?.assignee,
          },
        )),
        ...followupChildren.map((issue) => buildPlanningChildRecord(issue, "execution", {
          dueDate: researchChild?.dueDate ?? parent?.dueDate ?? undefined,
        })),
      ],
      planningReason,
      ownerResolution: usedFallbackOwners.size > 0 ? "fallback" : "mapped",
      lastResolvedIssueId: researchChild.identifier,
      originalText: requestMessage.text,
    });

    return {
      handled: true,
      reply: buildResearchSlackSummary({
        parent: parent!,
        researchChild,
        reusedParent: Boolean(existingResearchParent),
        synthesis: researchSynthesis,
        followupChildren,
      }),
    };
  }

  const ownerResolution = usedFallbackOwners.size > 0 ? "fallback" : "mapped";
  const effectiveParent = parent ?? threadParentIssue;
  const lastResolvedIssueId = createdChildren.length === 1
    ? createdChildren[0]?.identifier
    : createdChildren.length === 0 ? effectiveParent?.identifier : undefined;

  const planningEntry: PlanningLedgerEntry = {
    sourceThread: `${message.channelId}:${message.rootThreadTs}`,
    parentIssueId: effectiveParent?.identifier,
    generatedChildIssueIds: createdChildren.map((issue) => issue.identifier),
    planningReason,
    ownerResolution,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  await repositories.planning.save([...planningLedger, planningEntry]);
  await recordPlanningOutcome(repositories.workgraph, {
    occurredAt,
    source: workgraphSource,
    messageFingerprint: fingerprint,
    parentIssue: createdParent
      ? {
          issueId: createdParent.identifier,
          title: createdParent.title,
          dueDate: globalDueDate,
          assignee: parentOwner?.entry.linearAssignee,
        }
      : undefined,
    parentIssueId: effectiveParent?.identifier,
    childIssues: createdChildren.map((issue, index) => buildPlanningChildRecord(
      issue,
      plannedChildren[index]?.isResearch ? "research" : "execution",
      {
        dueDate: plannedChildren[index]?.dueDate,
        assignee: plannedChildren[index]?.assignee,
      },
    )),
    planningReason,
    ownerResolution,
    lastResolvedIssueId,
    originalText: requestMessage.text,
  });

  return {
    handled: true,
    reply: formatAutonomousCreateReply(effectiveParent, createdChildren, planningReason, usedFallbackOwners.size > 0, {
      reusedParent: Boolean(existingResearchParent),
      attachedToExistingParent: Boolean(threadParentIssue && !existingResearchParent && !createdParent),
    }),
  };
}
