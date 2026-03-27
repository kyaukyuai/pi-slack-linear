import { describe, expect, it } from "vitest";
import {
  buildDuplicateCandidateQueryVariants,
  mergeDuplicateCandidateQueryResults,
} from "../src/lib/linear-duplicate-candidates.js";

describe("linear duplicate candidates", () => {
  it("builds deterministic query variants for Japanese duplicate recall", () => {
    expect(buildDuplicateCandidateQueryVariants("金澤さんのChatGPTのプロジェクト招待")).toEqual([
      "金澤 chatgpt プロジェクト 招待",
      "金澤 chatgpt プロジェクト",
      "chatgpt プロジェクト 招待",
      "金澤 chatgpt",
      "プロジェクト 招待",
    ]);
  });

  it("unions repeated search hits and ranks candidates by matchedQueries then token overlap", () => {
    const ranked = mergeDuplicateCandidateQueryResults({
      requestText: "金澤さんのChatGPTのプロジェクト招待",
      queryResults: [
        {
          query: "金澤 chatgpt プロジェクト",
          issues: [
            {
              id: "issue-61",
              identifier: "AIC-61",
              title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
              url: "https://linear.app/kyaukyuai/issue/AIC-61",
              state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
              updatedAt: "2026-03-27T06:00:00.000Z",
              relations: [],
              inverseRelations: [],
            },
            {
              id: "issue-91",
              identifier: "AIC-91",
              title: "金澤さんにChatGPT利用方針を確認する",
              url: "https://linear.app/kyaukyuai/issue/AIC-91",
              state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
              updatedAt: "2026-03-27T07:00:00.000Z",
              relations: [],
              inverseRelations: [],
            },
          ],
        },
        {
          query: "プロジェクト 招待",
          issues: [
            {
              id: "issue-61",
              identifier: "AIC-61",
              title: "金澤さんのChatGPTプロジェクトに角井さんを招待してもらう",
              url: "https://linear.app/kyaukyuai/issue/AIC-61",
              state: { id: "state-backlog", name: "Backlog", type: "unstarted" },
              updatedAt: "2026-03-27T06:00:00.000Z",
              relations: [],
              inverseRelations: [],
            },
          ],
        },
      ],
      limit: 5,
    });

    expect(ranked).toMatchObject([
      {
        identifier: "AIC-61",
        matchedQueries: ["金澤 chatgpt プロジェクト", "プロジェクト 招待"],
        matchedTokenCount: 4,
      },
      {
        identifier: "AIC-91",
        matchedQueries: ["金澤 chatgpt プロジェクト"],
        matchedTokenCount: 2,
      },
    ]);
  });
});
