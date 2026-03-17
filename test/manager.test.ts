import { describe, expect, it } from "vitest";
import {
  assessRisk,
  businessDaysSince,
  chooseOwner,
  classifyManagerSignal,
  detectClarificationNeeds,
  deriveIssueTitle,
  extractTaskSegments,
  fingerprintText,
  formatClarificationReply,
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
  fallbackOwner: "kyaukyuai",
  autoCreate: true,
  autoAssign: true,
  autoPlan: true,
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
    expect(classifyManagerSignal("AIC-2 は完了しました")).toBe("completed");
    expect(classifyManagerSignal("AIC-2 は blocked です")).toBe("blocked");
  });

  it("extracts task segments from bullet lists", () => {
    const segments = extractTaskSegments(`
- ログイン画面の調査
- API 仕様の確認
    `);

    expect(segments).toEqual(["ログイン画面の調査", "API 仕様の確認"]);
  });

  it("derives stable issue titles and fingerprints", () => {
    expect(deriveIssueTitle("明日の会議準備のタスクを追加しておいて")).toBe("明日の会議準備");
    expect(fingerprintText("ログイン画面の issue を作って")).toContain("ログイン画面");
  });

  it("detects research requests and resolves owners", () => {
    expect(needsResearchTask("ログイン画面の不具合を調査して")).toBe(true);
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
});
