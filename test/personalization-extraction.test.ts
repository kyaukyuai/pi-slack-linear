import { describe, expect, it } from "vitest";
import {
  parsePersonalizationExtractionReply,
  runPersonalizationExtractionTurnWithExecutor,
} from "../src/planners/personalization-extraction/index.js";

describe("personalization extraction", () => {
  it("downgrades malformed observations with blank canonicalText into ignore", () => {
    const result = parsePersonalizationExtractionReply(JSON.stringify({
      observations: [
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "context",
          summary: "Heartbeat no-op",
          canonicalText: "   ",
          confidence: 0.83,
        },
      ],
    }));

    expect(result).toEqual({
      observations: [{ kind: "ignore" }],
    });
  });

  it("keeps valid observations even when malformed ones are mixed in", () => {
    const result = parsePersonalizationExtractionReply(JSON.stringify({
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "terminology",
          summary: "Prefer issue wording",
          canonicalText: "常に task ではなく issue と呼ぶ。",
          confidence: 1,
        },
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "context",
          summary: "Blank candidate",
          canonicalText: "",
          confidence: 0.7,
        },
      ],
    }));

    expect(result).toEqual({
      observations: [
        {
          kind: "operating_rule",
          source: "explicit",
          category: "terminology",
          summary: "Prefer issue wording",
          canonicalText: "常に task ではなく issue と呼ぶ。",
          confidence: 1,
        },
        { kind: "ignore" },
      ],
    });
  });

  it("accepts project-scoped observations when projectName is present", () => {
    const result = parsePersonalizationExtractionReply(JSON.stringify({
      observations: [
        {
          kind: "preference_or_fact",
          source: "explicit",
          category: "project-overview",
          projectName: "AIクローンプラットフォーム",
          summary: "PoC の主題",
          canonicalText: "AIクローンプラットフォームは金澤クローンを中心とした PoC プロジェクトである。",
          confidence: 0.98,
        },
      ],
    }));

    expect(result).toEqual({
      observations: [
        {
          kind: "preference_or_fact",
          source: "explicit",
          category: "project-overview",
          projectName: "AIクローンプラットフォーム",
          summary: "PoC の主題",
          canonicalText: "AIクローンプラットフォームは金澤クローンを中心とした PoC プロジェクトである。",
          confidence: 0.98,
        },
      ],
    });
  });

  it("drops roadmap observations that look like issue-level status", () => {
    const result = parsePersonalizationExtractionReply(JSON.stringify({
      observations: [
        {
          kind: "preference_or_fact",
          source: "inferred",
          category: "roadmap-and-milestones",
          projectName: "AIクローンプラットフォーム",
          summary: "AIC-38 の現在期限",
          canonicalText: "AIC-38 は 2026-03-27 期限で現在 Backlog のままです。",
          confidence: 0.9,
        },
      ],
    }));

    expect(result).toEqual({
      observations: [{ kind: "ignore" }],
    });
  });

  it("survives malformed low-value replies through the planner runner", async () => {
    const result = await runPersonalizationExtractionTurnWithExecutor(
      async () => JSON.stringify({
        observations: [
          {
            kind: "operating_rule",
            source: "inferred",
            category: "workflow",
            summary: "No durable rule",
            canonicalText: "",
            confidence: 0.66,
          },
        ],
      }),
      {
        turnKind: "manager-system",
        latestUserMessage: "heartbeat noop",
        latestAssistantReply: "HEARTBEAT_OK",
        committedCommands: [],
        rejectedReasons: [],
        currentDate: "2026-03-25",
      },
    );

    expect(result.observations).toEqual([{ kind: "ignore" }]);
  });
});
