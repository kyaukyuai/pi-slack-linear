import { describe, expect, it } from "vitest";
import {
  assessRisk,
  businessDaysSince,
  chooseOwner,
  classifyManagerQuery,
  classifyManagerSignal,
  detectClarificationNeeds,
  deriveIssueTitle,
  extractTaskSegments,
  fingerprintText,
  formatControlRoomFollowupForSlack,
  formatControlRoomReviewForSlack,
  formatClarificationReply,
  formatIssueLineForSlack,
  needsResearchTask,
} from "../src/lib/manager.js";
import type { ManagerPolicy, OwnerMap } from "../src/lib/manager-state.js";

const policy: ManagerPolicy = {
  controlRoomChannelId: "C0ALAMDRB9V",
  businessHours: {
    timezone: "Asia/Tokyo",
    weekdays: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "18:00",
  },
  reviewCadence: {
    morning: "09:00",
    evening: "17:00",
    weeklyDay: "mon",
    weeklyTime: "09:30",
  },
  heartbeatIntervalMin: 30,
  staleBusinessDays: 3,
  blockedBusinessDays: 1,
  followupCooldownHours: 24,
  clarificationCooldownHours: 12,
  fallbackOwner: "kyaukyuai",
  autoCreate: true,
  autoStatusUpdate: true,
  autoAssign: true,
  autoPlan: true,
  reviewExplicitFollowupCount: 1,
  researchAutoPlanMinActions: 2,
  researchAutoPlanMaxChildren: 3,
  urgentPriorityThreshold: 2,
};

const ownerMap: OwnerMap = {
  defaultOwner: "kyaukyuai",
  entries: [
    {
      id: "frontend",
      domains: ["frontend", "ui"],
      keywords: ["ログイン", "画面", "UI"],
      linearAssignee: "y.kakui",
      primary: true,
    },
    {
      id: "kyaukyuai",
      domains: ["default"],
      keywords: [],
      linearAssignee: "y.kakui",
      primary: true,
    },
  ],
};

describe("manager helpers", () => {
  it("classifies request and completion signals", () => {
    expect(classifyManagerSignal("ログイン修復のタスクを追加して")).toBe("request");
    expect(classifyManagerSignal("今日やるべきタスクある？")).toBe("query");
    expect(classifyManagerSignal("タスク一覧を確認して")).toBe("query");
    expect(classifyManagerSignal("AIC-38 の状況は？")).toBe("query");
    expect(classifyManagerSignal("既存 issue あったっけ？")).toBe("query");
    expect(classifyManagerSignal("AIC-2 は完了しました")).toBe("completed");
    expect(classifyManagerSignal("AIC-2 は blocked です")).toBe("blocked");
  });

  it("distinguishes query kinds for list and prioritization requests", () => {
    expect(classifyManagerQuery("今日やるべきタスクある？")).toBe("what-should-i-do");
    expect(classifyManagerQuery("自分の今日やるべきタスクある？")).toBe("what-should-i-do");
    expect(classifyManagerQuery("今日のタスク一覧を確認して")).toBe("list-today");
    expect(classifyManagerQuery("タスク一覧を確認して")).toBe("list-active");
    expect(classifyManagerQuery("この件どうなってる？")).toBe("inspect-work");
    expect(classifyManagerQuery("AIC-38 の状況は？")).toBe("inspect-work");
    expect(classifyManagerQuery("既存 issue あったっけ？")).toBe("search-existing");
  });

  it("extracts task segments from bullet lists", () => {
    const segments = extractTaskSegments(`
- ログイン画面の調査
- API 仕様の確認
    `);

    expect(segments).toEqual(["ログイン画面の調査", "API 仕様の確認"]);
  });

  it("keeps numeric prefixes that are part of the task title and drops list headings", () => {
    const segments = extractTaskSegments(`
3. タスク一覧
1. 2ヶ月版の見積もり書作成（担当：角井 勇哉, 期限：未定）
2. 4月・5月の2ヶ月間でのクローン成果物の作成（担当：角井 勇哉, 期限：2026-05-31）
    `);

    expect(segments).toEqual([
      "2ヶ月版の見積もり書作成（担当：角井 勇哉, 期限：未定）",
      "4月・5月の2ヶ月間でのクローン成果物の作成（担当：角井 勇哉, 期限：2026-05-31）",
    ]);
    expect(deriveIssueTitle("1. 2ヶ月版の見積もり書作成")).toBe("2ヶ月版の見積もり書作成");
    expect(deriveIssueTitle("2. 4月・5月の2ヶ月間でのクローン成果物の作成")).toBe("4月・5月の2ヶ月間でのクローン成果物の作成");
  });

  it("derives stable issue titles and fingerprints", () => {
    expect(deriveIssueTitle("明日の会議準備のタスクを追加しておいて")).toBe("明日の会議準備");
    expect(fingerprintText("ログイン画面の issue を作って")).toContain("ログイン画面");
  });

  it("detects research requests and resolves owners", () => {
    expect(needsResearchTask("ログイン画面の不具合を調査して")).toBe(true);
    expect(needsResearchTask("ログイン画面の不具合を調査して。API 仕様の確認と修正方針の整理が必要です。")).toBe(true);
    expect(needsResearchTask(`期限は 2026-03-20 で、作業は
- API 仕様の確認
- デプロイ履歴の確認
に分けて進めて`)).toBe(false);
    expect(chooseOwner("ログイン画面の不具合修正", ownerMap).resolution).toBe("mapped");
    expect(chooseOwner("バックオフィス運用タスク", ownerMap).resolution).toBe("fallback");
  });

  it("detects clarification needs for vague and urgent requests", () => {
    expect(detectClarificationNeeds("これ対応しておいて")).toEqual(["scope"]);
    expect(detectClarificationNeeds("急ぎでログイン画面の不具合を直して")).toEqual(["due_date"]);
    expect(detectClarificationNeeds("来週のリリースに向けた対応を進めておいて")).toEqual(
      expect.arrayContaining(["due_date", "execution_plan"]),
    );
  });

  it("formats a clarification reply with concrete asks", () => {
    const reply = formatClarificationReply("ログイン画面の不具合修正", ["due_date", "execution_plan"]);
    expect(reply).toContain("起票前に確認したい点があります");
    expect(reply).toContain("対象は ログイン画面の不具合修正 です。");
    expect(reply).toContain("期限を確認したいです");
    expect(reply).toContain("進め方を固めたいです");
  });

  it("counts business days in JST", () => {
    expect(
      businessDaysSince("2026-03-13T03:00:00.000Z", new Date("2026-03-17T03:00:00.000Z")),
    ).toBe(2);
  });

  it("categorizes risky issues", () => {
    const result = assessRisk(
      {
        id: "1",
        identifier: "AIC-1",
        title: "ログイン画面の不具合修正",
        dueDate: "2026-03-16",
        updatedAt: "2026-03-12T03:00:00.000Z",
        priority: 1,
        state: { id: "state-1", name: "Blocked", type: "started" },
        relations: [],
        inverseRelations: [],
      },
      policy,
      new Date("2026-03-17T03:00:00.000Z"),
    );

    expect(result.riskCategories).toEqual(
      expect.arrayContaining(["overdue", "stale", "blocked", "owner_missing"]),
    );
  });

  it("does not treat outgoing blocks relations as blocked risk", () => {
    const result = assessRisk(
      {
        id: "2",
        identifier: "AIC-2",
        title: "後続タスクを block する issue",
        updatedAt: "2026-03-16T03:00:00.000Z",
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [{ id: "rel-1", type: "blocks", relatedIssue: { identifier: "AIC-3", title: "後続" } }],
        inverseRelations: [],
      },
      policy,
      new Date("2026-03-17T03:00:00.000Z"),
    );

    expect(result.blocked).toBe(false);
    expect(result.riskCategories).not.toContain("blocked");
  });

  it("treats blocked-by dependencies as blocked risk", () => {
    const result = assessRisk(
      {
        id: "3",
        identifier: "AIC-3",
        title: "依存待ちの issue",
        updatedAt: "2026-03-16T03:00:00.000Z",
        assignee: { id: "user-1", displayName: "y.kakui" },
        state: { id: "state-1", name: "Started", type: "started" },
        relations: [],
        inverseRelations: [{ id: "rel-1", type: "blocks", issue: { identifier: "AIC-1", title: "先行" } }],
      },
      policy,
      new Date("2026-03-17T03:00:00.000Z"),
    );

    expect(result.blocked).toBe(true);
    expect(result.riskCategories).toContain("blocked");
  });

  it("formats compact issue lines for control room posts", () => {
    expect(formatIssueLineForSlack({
      issueId: "AIC-1",
      title: "ログイン画面の不具合修正",
      issueUrl: "https://linear.app/kyaukyuai/issue/AIC-1",
      assigneeDisplayName: "y.kakui",
      riskSummary: "overdue, blocked",
    })).toBe("- <https://linear.app/kyaukyuai/issue/AIC-1|AIC-1> ログイン画面の不具合修正。担当は y.kakui です。気になっている点は overdue, blocked です。");
  });

  it("mentions assignees only for important follow-ups when slack user ids are available", () => {
    expect(formatControlRoomFollowupForSlack({
      issueId: "AIC-1",
      issueTitle: "ログイン画面の不具合修正",
      issueUrl: "https://linear.app/kyaukyuai/issue/AIC-1",
      request: "原因と、誰の返答待ちか、何がそろえば再開できるかを共有してください。",
      requestKind: "blocked-details",
      acceptableAnswerHint: "原因 / 待ち先 / 再開条件",
      assigneeDisplayName: "y.kakui",
      slackUserId: "U123",
      riskCategory: "blocked",
      shouldMention: true,
    }, "https://slack.example/thread")).toContain("<@U123>");

    expect(formatControlRoomFollowupForSlack({
      issueId: "AIC-2",
      issueTitle: "期限確認待ち task",
      issueUrl: "https://linear.app/kyaukyuai/issue/AIC-2",
      request: "期限を YYYY-MM-DD で共有してください。",
      requestKind: "due-date",
      acceptableAnswerHint: "YYYY-MM-DD",
      assigneeDisplayName: "y.kakui",
      riskCategory: "due_missing",
      shouldMention: false,
    }, "https://slack.example/thread")).not.toContain("<@");
  });

  it("formats control room reviews with a heading, at most three issue lines, and one follow-up", () => {
    const review = formatControlRoomReviewForSlack({
      kind: "morning-review",
      text: "fallback text",
      summaryLines: ["今日やるべきこと", "期限リスク", "stale"],
      issueLines: [
        { issueId: "AIC-1", issueUrl: "https://linear.app/kyaukyuai/issue/AIC-1", title: "task 1", assigneeDisplayName: "a", riskSummary: "overdue" },
        { issueId: "AIC-2", issueUrl: "https://linear.app/kyaukyuai/issue/AIC-2", title: "task 2", assigneeDisplayName: "b", riskSummary: "blocked" },
        { issueId: "AIC-3", issueUrl: "https://linear.app/kyaukyuai/issue/AIC-3", title: "task 3", assigneeDisplayName: "c", riskSummary: "stale" },
        { issueId: "AIC-4", issueUrl: "https://linear.app/kyaukyuai/issue/AIC-4", title: "task 4", assigneeDisplayName: "d", riskSummary: "due_today" },
      ],
      followup: {
        issueId: "AIC-2",
        issueTitle: "task 2",
        issueUrl: "https://linear.app/kyaukyuai/issue/AIC-2",
        request: "原因と、誰の返答待ちか、何がそろえば再開できるかを共有してください。",
        requestKind: "blocked-details",
        acceptableAnswerHint: "原因 / 待ち先 / 再開条件",
        assigneeDisplayName: "b",
        slackUserId: "U456",
        riskCategory: "blocked",
        shouldMention: true,
      },
    }, "https://slack.example/thread");

    expect(review).toContain("おはようございます。今朝の確認で、優先して見てほしい点があります。");
    expect(review).toContain("- <https://linear.app/kyaukyuai/issue/AIC-1|AIC-1> task 1。担当は a です。気になっている点は overdue です。");
    expect(review).toContain("- <https://linear.app/kyaukyuai/issue/AIC-2|AIC-2> task 2。担当は b です。気になっている点は blocked です。");
    expect(review).toContain("- <https://linear.app/kyaukyuai/issue/AIC-3|AIC-3> task 3。担当は c です。気になっている点は stale です。");
    expect(review).not.toContain("AIC-4");
    expect(review).toContain("気になっている点があります。 <@U456>、<https://linear.app/kyaukyuai/issue/AIC-2|AIC-2> について");
    expect(review).toContain("返答フォーマットは 原因 / 待ち先 / 再開条件 です。");
  });
});
