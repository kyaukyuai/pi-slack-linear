import { describe, expect, it } from "vitest";
import {
  buildCreateIssueArgs,
  buildIssueUrlArgs,
  buildListActiveIssuesArgs,
  buildUpdateIssueStateArgs,
} from "../src/lib/linear.js";

describe("linear command builders", () => {
  it("creates issue args with fixed team and without workspace when api key is set", () => {
    const args = buildCreateIssueArgs(
      {
        title: "Smoke test",
        description: "# Summary\n- test",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toContain("--team");
    expect(args).toContain("KYA");
    expect(args).not.toContain("-w");
    expect(args).toContain("--description");
  });

  it("falls back to workspace args when api key is absent", () => {
    const args = buildListActiveIssuesArgs(10, {
      LINEAR_WORKSPACE: "kyaukyuai",
      LINEAR_TEAM_KEY: "KYA",
      LINEAR_API_KEY: "",
    });

    expect(args).toContain("-w");
    expect(args).toContain("kyaukyuai");
    expect(args).toContain("--team");
    expect(args).toContain("KYA");
  });

  it("lists active issues with stable sort and state filters", () => {
    const args = buildListActiveIssuesArgs(10, {
      LINEAR_API_KEY: "lin_api_test",
      LINEAR_TEAM_KEY: "KYA",
    });

    expect(args.slice(0, 3)).toEqual(["issue", "list", "--all-assignees"]);
    expect(args).toContain("--sort");
    expect(args).toContain("manual");
    expect(args).toContain("unstarted");
    expect(args).toContain("started");
  });

  it("updates issue state with the expected move command", () => {
    const args = buildUpdateIssueStateArgs(
      {
        issueId: "KYA-123",
        state: "completed",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toEqual(["issue", "move", "KYA-123", "completed"]);
  });

  it("builds issue url args", () => {
    const args = buildIssueUrlArgs("KYA-123", {
      LINEAR_API_KEY: "lin_api_test",
    });

    expect(args).toEqual(["issue", "url", "KYA-123"]);
  });
});
