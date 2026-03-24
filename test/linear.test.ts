import { describe, expect, it } from "vitest";
import {
  buildCreateIssueArgs,
  buildCreateBatchArgs,
  buildCreateLinearWebhookArgs,
  buildDeleteLinearWebhookArgs,
  buildIssueChildrenArgs,
  buildIssueCommentAddArgs,
  buildGetIssueArgs,
  buildIssueUrlArgs,
  buildListActiveIssuesArgs,
  buildListLinearWebhooksArgs,
  buildSearchIssuesArgs,
  buildTeamMembersArgs,
  buildUpdateLinearWebhookArgs,
  buildUpdateIssueArgs,
  normalizeLinearIssuePayload,
  normalizeLinearWebhookPayload,
  normalizeRelationListPayload,
  normalizeTeamMembersPayload,
  parseLinearBatchCreateFailure,
  planLinearIssueCreatedWebhookReconcile,
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

  it("passes due date during issue creation when provided", () => {
    const args = buildCreateIssueArgs(
      {
        title: "Prepare meeting",
        description: "# Summary\n- prepare",
        dueDate: "2026-03-20",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toContain("--due-date");
    expect(args).toContain("2026-03-20");
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

  it("updates issue state with the expected update command", () => {
    const args = buildUpdateIssueArgs(
      {
        issueId: "KYA-123",
        state: "completed",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toEqual(["issue", "update", "KYA-123", "--state", "completed"]);
  });

  it("updates due date and supports clearing it", () => {
    const setArgs = buildUpdateIssueArgs(
      {
        issueId: "KYA-123",
        dueDate: "2026-03-20",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );
    const clearArgs = buildUpdateIssueArgs(
      {
        issueId: "KYA-123",
        clearDueDate: true,
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(setArgs).toEqual(["issue", "update", "KYA-123", "--due-date", "2026-03-20"]);
    expect(clearArgs).toEqual(["issue", "update", "KYA-123", "--clear-due-date"]);
  });

  it("builds issue url args", () => {
    const args = buildIssueUrlArgs("KYA-123", {
      LINEAR_API_KEY: "lin_api_test",
    });

    expect(args).toEqual(["issue", "url", "KYA-123"]);
  });

  it("builds issue view args with and without comments", () => {
    expect(buildGetIssueArgs("KYA-123", {
      LINEAR_API_KEY: "lin_api_test",
    })).toEqual(["issue", "view", "KYA-123", "--json", "--no-comments"]);

    expect(buildGetIssueArgs("KYA-123", {
      LINEAR_API_KEY: "lin_api_test",
    }, { includeComments: true })).toEqual(["issue", "view", "KYA-123", "--json"]);
  });

  it("builds JSON search args with parent and date filters", () => {
    const args = buildSearchIssuesArgs(
      {
        query: "auth",
        parent: "KYA-10",
        priority: 2,
        updatedBefore: "2026-03-31T00:00:00Z",
        dueBefore: "2026-04-07",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      },
    );

    expect(args).toContain("--json");
    expect(args).toContain("--sort");
    expect(args).toContain("manual");
    expect(args).toContain("--query");
    expect(args).toContain("auth");
    expect(args).toContain("--parent");
    expect(args).toContain("KYA-10");
    expect(args).toContain("--priority");
    expect(args).toContain("2");
    expect(args).toContain("--updated-before");
    expect(args).toContain("2026-03-31T00:00:00Z");
    expect(args).toContain("--due-before");
    expect(args).toContain("2026-04-07");
  });

  it("builds comment, children, team members, and batch args for v2.4.0 commands", () => {
    expect(
      buildIssueCommentAddArgs("KYA-123", "tracking", {
        LINEAR_API_KEY: "lin_api_test",
      }),
    ).toEqual(["issue", "comment", "add", "KYA-123", "--body", "tracking", "--json"]);

    expect(
      buildIssueChildrenArgs("KYA-123", {
        LINEAR_API_KEY: "lin_api_test",
      }),
    ).toEqual(["issue", "children", "KYA-123", "--json"]);

    expect(
      buildTeamMembersArgs({
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "KYA",
      }),
    ).toEqual(["team", "members", "KYA", "--json"]);

    expect(
      buildCreateBatchArgs("/tmp/issue-batch.json", {
        LINEAR_API_KEY: "lin_api_test",
      }),
    ).toEqual(["issue", "create-batch", "--file", "/tmp/issue-batch.json", "--json"]);
  });

  it("builds Linear webhook list/create/update/delete args", () => {
    expect(
      buildListLinearWebhooksArgs("AIC", {
        LINEAR_API_KEY: "lin_api_test",
      }),
    ).toEqual(["webhook", "list", "--team", "AIC", "--json"]);

    expect(
      buildCreateLinearWebhookArgs(
        {
          label: "cogito-work-manager-issue-created",
          url: "https://example.com/hooks/linear",
          teamKey: "AIC",
          secret: "secret-1",
        },
        {
          LINEAR_API_KEY: "lin_api_test",
        },
      ),
    ).toEqual([
      "webhook",
      "create",
      "--url",
      "https://example.com/hooks/linear",
      "--resource-types",
      "Issue",
      "--label",
      "cogito-work-manager-issue-created",
      "--team",
      "AIC",
      "--secret",
      "secret-1",
      "--json",
    ]);

    expect(
      buildUpdateLinearWebhookArgs(
        "webhook-1",
        {
          label: "cogito-work-manager-issue-created",
          url: "https://example.com/hooks/linear",
          teamKey: "AIC",
          secret: "secret-1",
        },
        {
          LINEAR_API_KEY: "lin_api_test",
        },
      ),
    ).toEqual([
      "webhook",
      "update",
      "webhook-1",
      "--url",
      "https://example.com/hooks/linear",
      "--resource-types",
      "Issue",
      "--label",
      "cogito-work-manager-issue-created",
      "--team",
      "AIC",
      "--secret",
      "secret-1",
      "--json",
    ]);

    expect(
      buildDeleteLinearWebhookArgs("webhook-1", {
        LINEAR_API_KEY: "lin_api_test",
      }),
    ).toEqual(["webhook", "delete", "webhook-1", "--json"]);
  });

  it("parses structured create-batch partial failures from linear-cli v2.8.0", () => {
    const failure = parseLinearBatchCreateFailure(JSON.stringify({
      success: false,
      error: {
        type: "cli_error",
        message: "Issue batch creation failed while creating child 2 of 7",
        suggestion: "Already created issues: AIC-201, AIC-202.",
        context: "Failed to create issue batch",
        details: {
          command: "issue.create-batch",
          createdIdentifiers: ["AIC-201", "AIC-202"],
          createdCount: 2,
          failedStep: {
            stage: "child",
            index: 2,
            total: 7,
            title: "千島さんとの契約・予算の詳細詰め",
          },
          retryHint: "Do not rerun the same batch file unchanged after a partial failure.",
        },
      },
    }));

    expect(failure).toEqual({
      message: "Issue batch creation failed while creating child 2 of 7",
      suggestion: "Already created issues: AIC-201, AIC-202.",
      context: "Failed to create issue batch",
      createdIdentifiers: ["AIC-201", "AIC-202"],
      createdCount: 2,
      failedStep: {
        stage: "child",
        index: 2,
        total: 7,
        title: "千島さんとの契約・予算の詳細詰め",
      },
      retryHint: "Do not rerun the same batch file unchanged after a partial failure.",
    });
  });

  it("normalizes issue view payloads with hierarchy and relations", () => {
    const issue = normalizeLinearIssuePayload({
      id: "issue-123",
      identifier: "TEST-123",
      title: "Fix authentication bug in login flow",
      description: "Users are experiencing issues logging in when their session expires.",
      url: "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
      dueDate: "2025-08-25",
      priority: 2,
      priorityLabel: "High",
      cycle: {
        id: "cycle-1",
        number: 42,
        name: "Sprint 42",
        startsAt: "2025-08-11",
        endsAt: "2025-08-24",
      },
      updatedAt: "2025-08-16T15:30:00Z",
      assignee: {
        id: "user-1",
        name: "jane.doe",
        displayName: "Jane Doe",
        initials: "JD",
      },
      state: {
        name: "In Progress",
        color: "#f87462",
      },
      parent: {
        id: "issue-100",
        identifier: "TEST-100",
        title: "Epic: Security Improvements",
        url: "https://linear.app/test-team/issue/TEST-100/epic-security-improvements",
      },
      children: [
        {
          id: "issue-200",
          identifier: "TEST-200",
          title: "Update session middleware",
          url: "https://linear.app/test-team/issue/TEST-200/update-session-middleware",
        },
      ],
      relations: {
        blocks: [
          {
            relationId: "relation-1",
            id: "issue-201",
            identifier: "TEST-201",
            title: "Blocked issue",
            url: "https://linear.app/test-team/issue/TEST-201/blocked-issue",
          },
        ],
        blockedBy: [
          {
            relationId: "relation-2",
            id: "issue-202",
            identifier: "TEST-202",
            title: "Blocking issue",
            url: "https://linear.app/test-team/issue/TEST-202/blocking-issue",
          },
        ],
      },
      comments: [
        {
          id: "comment-1",
          body: "## Progress update\nAPI 実装を進めています",
          createdAt: "2025-08-16T15:31:00Z",
          user: {
            id: "user-1",
            displayName: "Jane Doe",
          },
        },
      ],
    });

    expect(issue).toMatchObject({
      identifier: "TEST-123",
      title: "Fix authentication bug in login flow",
      priorityLabel: "High",
      cycle: {
        id: "cycle-1",
        number: 42,
        name: "Sprint 42",
      },
      parent: {
        identifier: "TEST-100",
      },
      children: [
        {
          identifier: "TEST-200",
        },
      ],
      relations: [
        {
          type: "blocks",
          relatedIssue: {
            identifier: "TEST-201",
          },
        },
      ],
      inverseRelations: [
        {
          type: "blocked-by",
          issue: {
            identifier: "TEST-202",
          },
        },
      ],
      latestActionKind: "progress",
    });
    expect(issue?.comments?.[0]?.body).toContain("API 実装");
  });

  it("normalizes relation-list and team-members payloads", () => {
    const relationPayload = normalizeRelationListPayload({
      outgoing: [
        {
          id: "relation-out-1",
          type: "blocks",
          issue: {
            id: "issue-456",
            identifier: "ENG-456",
            title: "Blocked issue",
            url: "https://linear.app/issue/ENG-456",
          },
        },
      ],
      incoming: [
        {
          id: "relation-in-1",
          type: "blocked-by",
          issue: {
            id: "issue-789",
            identifier: "ENG-789",
            title: "Blocking issue",
            url: "https://linear.app/issue/ENG-789",
          },
        },
      ],
    });

    expect(relationPayload.relations?.[0]).toMatchObject({
      type: "blocks",
      relatedIssue: { identifier: "ENG-456" },
    });
    expect(relationPayload.inverseRelations?.[0]).toMatchObject({
      type: "blocked-by",
      issue: { identifier: "ENG-789" },
    });

    const members = normalizeTeamMembersPayload({
      team: "ENG",
      members: [
        {
          id: "user-2",
          name: "asmith",
          displayName: "Alice Smith",
          email: "alice@example.com",
        },
      ],
    });

    expect(members).toEqual([
      {
        id: "user-2",
        name: "asmith",
        displayName: "Alice Smith",
        email: "alice@example.com",
      },
    ]);
  });

  it("normalizes webhook payloads and plans reconcile actions", () => {
    const webhook = normalizeLinearWebhookPayload({
      id: "webhook-1",
      label: "cogito-work-manager-issue-created",
      url: "https://example.com/hooks/linear",
      enabled: true,
      resourceTypes: ["Issue"],
      secretConfigured: true,
      team: {
        id: "team-1",
        key: "AIC",
      },
    });

    expect(webhook).toEqual({
      id: "webhook-1",
      label: "cogito-work-manager-issue-created",
      url: "https://example.com/hooks/linear",
      enabled: true,
      resourceTypes: ["Issue"],
      teamId: "team-1",
      teamKey: "AIC",
      secretConfigured: true,
    });

    expect(planLinearIssueCreatedWebhookReconcile([], {
      label: "cogito-work-manager-issue-created",
      url: "https://example.com/hooks/linear",
      teamKey: "AIC",
      secret: "secret-1",
    })).toEqual({ action: "create" });

    expect(planLinearIssueCreatedWebhookReconcile([webhook!], {
      label: "cogito-work-manager-issue-created",
      url: "https://example.com/hooks/linear",
      teamKey: "AIC",
      secret: "secret-1",
    })).toEqual({
      action: "unchanged",
      webhook,
    });

    expect(planLinearIssueCreatedWebhookReconcile([
      webhook!,
      { ...webhook!, id: "webhook-2" },
    ], {
      label: "cogito-work-manager-issue-created",
      url: "https://example.com/hooks/linear",
      teamKey: "AIC",
      secret: "secret-1",
    })).toEqual({
      action: "disabled-duplicate",
      duplicateWebhooks: [webhook, { ...webhook!, id: "webhook-2" }],
    });

    expect(planLinearIssueCreatedWebhookReconcile([
      { ...webhook!, url: "https://example.com/old" },
    ], {
      label: "cogito-work-manager-issue-created",
      url: "https://example.com/hooks/linear",
      teamKey: "AIC",
      secret: "secret-1",
    })).toEqual({
      action: "update",
      webhook: { ...webhook!, url: "https://example.com/old" },
    });
  });
});
