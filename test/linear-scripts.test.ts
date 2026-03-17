import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = "/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear";
const scriptsDir = join(repoRoot, "skills/linear-cli/scripts");

function createLinearStub(): { binDir: string; outputFile: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "linear-script-test-"));
  const binDir = join(root, "bin");
  const outputFile = join(root, "args.txt");
  const script = join(binDir, "linear");

  execFileSync("mkdir", ["-p", binDir]);
  writeFileSync(
    script,
    `#!/usr/bin/env bash
printf '%s\n' "$@" > "${outputFile}"
`,
    "utf8",
  );
  chmodSync(script, 0o755);

  return {
    binDir,
    outputFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("linear helper scripts", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("create-issue.sh uses fixed team and skips workspace when LINEAR_API_KEY is set", () => {
    const stub = createLinearStub();
    cleanups.push(stub.cleanup);

    const descFile = join(tmpdir(), "desc-file.md");
    writeFileSync(descFile, "# Summary\n- test\n", "utf8");

    execFileSync(join(scriptsDir, "create-issue.sh"), ["--title", "Smoke test", "--description-file", descFile], {
      env: {
        ...process.env,
        PATH: `${stub.binDir}:${process.env.PATH ?? ""}`,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "KYA",
      },
    });

    const args = readFileSync(stub.outputFile, "utf8").trim().split("\n");
    expect(args).toContain("issue");
    expect(args).toContain("create");
    expect(args).toContain("--team");
    expect(args).toContain("KYA");
    expect(args).not.toContain("-w");
  });

  it("list-active.sh builds the expected issue list command", () => {
    const stub = createLinearStub();
    cleanups.push(stub.cleanup);

    execFileSync(join(scriptsDir, "list-active.sh"), ["--limit", "10"], {
      env: {
        ...process.env,
        PATH: `${stub.binDir}:${process.env.PATH ?? ""}`,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "KYA",
      },
    });

    const args = readFileSync(stub.outputFile, "utf8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual(["issue", "list", "--all-assignees"]);
    expect(args).toContain("--team");
    expect(args).toContain("KYA");
    expect(args).toContain("unstarted");
    expect(args).toContain("started");
  });

  it("complete-issue.sh moves an issue to completed", () => {
    const stub = createLinearStub();
    cleanups.push(stub.cleanup);

    execFileSync(join(scriptsDir, "complete-issue.sh"), ["KYA-123"], {
      env: {
        ...process.env,
        PATH: `${stub.binDir}:${process.env.PATH ?? ""}`,
        LINEAR_API_KEY: "lin_api_test",
        LINEAR_WORKSPACE: "kyaukyuai",
        LINEAR_TEAM_KEY: "KYA",
      },
    });

    const args = readFileSync(stub.outputFile, "utf8").trim().split("\n");
    expect(args).toEqual(["issue", "move", "KYA-123", "completed"]);
  });
});
