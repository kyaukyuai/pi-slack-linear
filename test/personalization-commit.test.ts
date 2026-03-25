import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPersonalizationObservations } from "../src/lib/personalization-commit.js";
import {
  buildSystemPaths,
  ensureSystemWorkspace,
  readWorkspaceAgents,
  readWorkspaceMemory,
} from "../src/lib/system-workspace.js";

describe("personalization commit", () => {
  it("promotes explicit operating rules into runtime workspace AGENTS", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    const result = await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "workflow",
          summary: "Prefer issue terminology",
          canonicalText: "常に task より issue という語を優先する。",
          confidence: 0.99,
        },
      ],
      now: new Date("2026-03-24T09:00:00.000Z"),
    });

    expect(result.promoted).toHaveLength(1);
    expect(result.updatedFiles).toEqual(["agents"]);
    await expect(readWorkspaceAgents(paths)).resolves.toContain("常に task より issue という語を優先する。");
  });

  it("keeps inferred memory as candidate until evidence threshold is met", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    const first = await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "preferences",
          summary: "Short processing notice",
          canonicalText: "Slack の考え中表示は「考え中...」を使う。",
          confidence: 0.85,
        },
      ],
      now: new Date("2026-03-24T09:00:00.000Z"),
    });

    expect(first.promoted).toHaveLength(0);
    expect(first.ledger[0]?.status).toBe("candidate");
    await expect(readWorkspaceMemory(paths)).resolves.toBeUndefined();

    const second = await applyPersonalizationObservations({
      paths,
      ledger: first.ledger,
      observations: [
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "preferences",
          summary: "Short processing notice",
          canonicalText: "Slack の考え中表示は「考え中...」を使う。",
          confidence: 0.9,
        },
      ],
      now: new Date("2026-03-24T10:00:00.000Z"),
    });

    expect(second.promoted).toHaveLength(1);
    expect(second.ledger[0]?.status).toBe("promoted");
    await expect(readWorkspaceMemory(paths)).resolves.toContain("Slack の考え中表示は「考え中...」を使う。");
  });

  it("renders project-centric MEMORY sections for explicit project knowledge", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "preference_or_fact",
          source: "explicit",
          category: "project-overview",
          projectName: "AIクローンプラットフォーム",
          summary: "PoC の主題",
          canonicalText: "AIクローンプラットフォームは金澤クローンを中心とした PoC プロジェクトである。",
          confidence: 1,
        },
        {
          kind: "preference_or_fact",
          source: "explicit",
          category: "members-and-roles",
          projectName: "AIクローンプラットフォーム",
          summary: "角井が推進担当",
          canonicalText: "角井がプロジェクト推進を担当し、コギトが実行支援に入る。",
          confidence: 1,
        },
        {
          kind: "preference_or_fact",
          source: "explicit",
          category: "roadmap-and-milestones",
          projectName: "AIクローンプラットフォーム",
          summary: "三ヶ月後の到達目標",
          canonicalText: "3ヶ月後に金澤クローンが Slack 上で日常相談に耐える状態を目標にする。",
          confidence: 1,
        },
      ],
      now: new Date("2026-03-25T02:00:00.000Z"),
    });

    const memory = await readWorkspaceMemory(paths);
    expect(memory).toContain("## Projects");
    expect(memory).toContain("### AIクローンプラットフォーム");
    expect(memory).toContain("#### Overview");
    expect(memory).toContain("#### Members And Roles");
    expect(memory).toContain("#### Roadmap And Milestones");
  });

  it("renders legacy people-and-projects entries under general project context", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "preference_or_fact",
          source: "explicit",
          category: "people-and-projects",
          summary: "General legacy project fact",
          canonicalText: "AIクローンプラットフォームはコギトとの協働プロジェクトである。",
          confidence: 1,
        },
      ],
      now: new Date("2026-03-25T02:10:00.000Z"),
    });

    const memory = await readWorkspaceMemory(paths);
    expect(memory).toContain("## General Project Context");
    expect(memory).toContain("AIクローンプラットフォームはコギトとの協働プロジェクトである。");
  });

  it("dedupes project memory by projectName, category, and summary", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    const first = await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "project-overview",
          projectName: "AIクローンプラットフォーム",
          summary: "PoC の主題",
          canonicalText: "AIクローンプラットフォームは金澤クローンを中心とした PoC プロジェクトである。",
          confidence: 0.84,
        },
      ],
      now: new Date("2026-03-25T02:20:00.000Z"),
    });

    const second = await applyPersonalizationObservations({
      paths,
      ledger: first.ledger,
      observations: [
        {
          kind: "preference_or_fact",
          source: "explicit",
          category: "project-overview",
          projectName: "AIクローンプラットフォーム",
          summary: "PoC の主題",
          canonicalText: "AIクローンプラットフォームは金澤クローンを中心とした PoC プロジェクトである。",
          confidence: 1,
        },
      ],
      now: new Date("2026-03-25T02:30:00.000Z"),
    });

    expect(second.ledger).toHaveLength(1);
    expect(second.ledger[0]?.source).toBe("explicit");
    expect(second.ledger[0]?.status).toBe("promoted");
  });

  it("supersedes conflicting rules with the same summary", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "cogito-work-manager-personalization-"));
    const paths = buildSystemPaths(workspaceDir);
    await ensureSystemWorkspace(paths);

    const first = await applyPersonalizationObservations({
      paths,
      ledger: [],
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "reply-style",
          summary: "Capability reply breadth",
          canonicalText: "能力説明では 3 項目までに絞る。",
          confidence: 1,
        },
      ],
      now: new Date("2026-03-24T09:00:00.000Z"),
    });

    const second = await applyPersonalizationObservations({
      paths,
      ledger: first.ledger,
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "reply-style",
          summary: "Capability reply breadth",
          canonicalText: "能力説明では 5 系統を簡潔な bullet で返す。",
          confidence: 1,
        },
      ],
      now: new Date("2026-03-24T11:00:00.000Z"),
    });

    const superseded = second.ledger.find((entry) => entry.canonicalText === "能力説明では 3 項目までに絞る。");
    const active = second.ledger.find((entry) => entry.canonicalText === "能力説明では 5 系統を簡潔な bullet で返す。");

    expect(superseded?.status).toBe("superseded");
    expect(active?.status).toBe("promoted");
    await expect(readWorkspaceAgents(paths)).resolves.toContain("能力説明では 5 系統を簡潔な bullet で返す。");
    await expect(readWorkspaceAgents(paths)).resolves.not.toContain("能力説明では 3 項目までに絞る。");
  });
});
