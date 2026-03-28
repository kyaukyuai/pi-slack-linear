import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function mockExecFileSuccess(handler: (args: string[]) => Promise<{ stdout: string; stderr?: string }>) {
  execFileMock.mockImplementation((_: string, args: string[], __: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    void handler(args)
      .then((result) => callback(null, { stdout: result.stdout, stderr: result.stderr ?? "" }))
      .catch((error) => callback(error as Error));
    return {} as never;
  });
}

function mockExecFileFailure(handler: (args: string[]) => Promise<Error>) {
  execFileMock.mockImplementation((_: string, args: string[], __: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    void handler(args).then((error) => callback(error));
    return {} as never;
  });
}

async function assertFileRemoved(filePath: string) {
  await expect(access(filePath, constants.F_OK)).rejects.toThrow();
}

afterEach(() => {
  execFileMock.mockReset();
  vi.resetModules();
});

describe("linear write path hardening", () => {
  it("rejects linear-cli versions below 2.9.0", async () => {
    mockExecFileSuccess(async () => ({ stdout: "linear-cli v2.8.0" }));
    const { verifyLinearCli } = await import("../src/lib/linear.js");

    await expect(verifyLinearCli("AIC")).rejects.toThrow("linear-cli v2.9.0 or newer is required");
  });

  it("uses --description-file for multiline managed issue creation and cleans the temp file", async () => {
    let descriptionFilePath = "";
    mockExecFileSuccess(async (args) => {
      const flagIndex = args.indexOf("--description-file");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args).not.toContain("--description");
      descriptionFilePath = args[flagIndex + 1] ?? "";
      expect(await readFile(descriptionFilePath, "utf8")).toBe("# Summary\n- markdown");
      return {
        stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Smoke test" }),
      };
    });
    const { createManagedLinearIssue } = await import("../src/lib/linear.js");

    await createManagedLinearIssue(
      {
        title: "Smoke test",
        description: "# Summary\n- markdown",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );

    expect(descriptionFilePath).toBeTruthy();
    await assertFileRemoved(descriptionFilePath);
  });

  it("uses --description-file for multiline managed issue updates and cleans the temp file", async () => {
    let descriptionFilePath = "";
    mockExecFileSuccess(async (args) => {
      const flagIndex = args.indexOf("--description-file");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args).not.toContain("--description");
      descriptionFilePath = args[flagIndex + 1] ?? "";
      expect(await readFile(descriptionFilePath, "utf8")).toBe("line 1\nline 2");
      return {
        stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Updated issue" }),
      };
    });
    const { updateManagedLinearIssue } = await import("../src/lib/linear.js");

    await updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        description: "line 1\nline 2",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );

    expect(descriptionFilePath).toBeTruthy();
    await assertFileRemoved(descriptionFilePath);
  });

  it("keeps single-line update descriptions inline", async () => {
    mockExecFileSuccess(async (args) => {
      expect(args).toContain("--description");
      expect(args).toContain("single line");
      expect(args).not.toContain("--description-file");
      return {
        stdout: JSON.stringify({ id: "issue-1", identifier: "AIC-1", title: "Updated issue" }),
      };
    });
    const { updateManagedLinearIssue } = await import("../src/lib/linear.js");

    await updateManagedLinearIssue(
      {
        issueId: "AIC-1",
        description: "single line",
      },
      {
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_TEAM_KEY: "AIC",
      },
    );
  });

  it("uses --body-file for multiline comments and cleans the temp file on failure", async () => {
    let commentFilePath = "";
    mockExecFileFailure(async (args) => {
      const flagIndex = args.indexOf("--body-file");
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args).not.toContain("--body");
      commentFilePath = args[flagIndex + 1] ?? "";
      expect(await readFile(commentFilePath, "utf8")).toBe("first line\nsecond line");
      const error = new Error("comment failed") as Error & { stdout: string; stderr: string };
      error.stdout = "";
      error.stderr = "";
      return error;
    });
    const { addLinearComment } = await import("../src/lib/linear.js");

    await expect(
      addLinearComment(
        "AIC-1",
        "first line\nsecond line",
        {
          LINEAR_API_KEY: "lin_api_test",
          LINEAR_TEAM_KEY: "AIC",
        },
      ),
    ).rejects.toThrow("comment failed");

    expect(commentFilePath).toBeTruthy();
    await assertFileRemoved(commentFilePath);
  });

  it("keeps repeated relation add calls as successful no-op capable operations", async () => {
    mockExecFileSuccess(async (args) => {
      expect(args.slice(0, 4)).toEqual(["issue", "relation", "add", "AIC-1"]);
      return {
        stdout: JSON.stringify({ success: true, noop: true }),
      };
    });
    const { addLinearRelation } = await import("../src/lib/linear.js");

    await expect(addLinearRelation("AIC-1", "blocks", "AIC-2", { LINEAR_API_KEY: "lin_api_test" })).resolves.toBeUndefined();
    await expect(addLinearRelation("AIC-1", "blocks", "AIC-2", { LINEAR_API_KEY: "lin_api_test" })).resolves.toBeUndefined();
  });
});
