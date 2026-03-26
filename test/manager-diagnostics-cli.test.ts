import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const tsxBin = join(repoDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const diagnosticsScript = join(repoDir, "scripts", "manager-diagnostics.ts");

describe("manager diagnostics cli", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads repo .env before building llm diagnostics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "manager-diagnostics-cli-"));
    tempDirs.push(cwd);

    await writeFile(join(cwd, ".env"), [
      "SLACK_APP_TOKEN=xapp-test",
      "SLACK_BOT_TOKEN=xoxb-test",
      "SLACK_ALLOWED_CHANNEL_IDS=C0ALAMDRB9V",
      "LINEAR_API_KEY=lin_api_test",
      "LINEAR_WORKSPACE=kyaukyuai",
      "LINEAR_TEAM_KEY=AIC",
      "ANTHROPIC_API_KEY=anthropic-test",
      "BOT_MODEL=claude-sonnet-4-6",
      "BOT_THINKING_LEVEL=minimal",
      "",
    ].join("\n"), "utf8");

    const { stdout } = await execFileAsync(tsxBin, [diagnosticsScript, "llm", "./workspace"], {
      cwd,
      env: process.env,
    });
    const json = stdout.slice(stdout.indexOf("{"));
    const diagnostics = JSON.parse(json) as {
      configured: { model: string };
      authSource: { source: string };
    };

    expect(diagnostics.configured.model).toBe("claude-sonnet-4-6");
    expect(diagnostics.authSource.source).toBe("runtime-override");
  });

  it("prints state file classifications for a workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "manager-diagnostics-state-"));
    tempDirs.push(cwd);

    const { stdout } = await execFileAsync(tsxBin, [diagnosticsScript, "state-files", "./workspace"], {
      cwd,
      env: process.env,
    });
    const json = stdout.slice(stdout.indexOf("{"));
    const diagnostics = JSON.parse(json) as {
      classificationSummary: { editable: string[]; internal: string[]; derived: string[] };
      operatorActionSummary: { doNotEdit: string[] };
      writePolicySummary: {
        "silent-auto-update": string[];
        "explicit-slack-update": string[];
        "manager-commit-only": string[];
      };
    };

    expect(diagnostics.classificationSummary.editable).toContain("policy.json");
    expect(diagnostics.classificationSummary.internal).toContain("followups.json");
    expect(diagnostics.classificationSummary.derived).toContain("sessions/");
    expect(diagnostics.operatorActionSummary.doNotEdit).toContain("workgraph-events.jsonl");
    expect(diagnostics.writePolicySummary["silent-auto-update"]).toContain("MEMORY.md");
    expect(diagnostics.writePolicySummary["explicit-slack-update"]).toContain("owner-map.json");
    expect(diagnostics.writePolicySummary["manager-commit-only"]).toContain("policy.json");
  });

  it("prints workspace memory coverage diagnostics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "manager-diagnostics-memory-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, "workspace", "system"), { recursive: true });
    await writeFile(join(cwd, "workspace", "system", "MEMORY.md"), [
      "## Projects",
      "",
      "### AIクローンプラットフォーム",
      "",
      "#### Overview",
      "- AIクローンプラットフォームは金澤クローンプロジェクトである。",
      "",
      "#### Members And Roles",
      "- 金澤さんが中心人物である。",
      "",
      "#### Roadmap And Milestones",
      "- 3ヶ月後の PoC 到達を主要マイルストーンとする。",
      "",
      "### OPT社内利用開始",
      "",
      "#### Overview",
      "- OPT 社内展開の導入フェーズである。",
      "",
    ].join("\n"), "utf8");

    const { stdout } = await execFileAsync(tsxBin, [diagnosticsScript, "memory", "./workspace"], {
      cwd,
      env: process.env,
    });
    const json = stdout.slice(stdout.indexOf("{"));
    const diagnostics = JSON.parse(json) as {
      totalProjects: number;
      completeProjects: string[];
      incompleteProjects: string[];
      projects: Array<{ projectName: string; missingSections: string[] }>;
    };

    expect(diagnostics.totalProjects).toBe(2);
    expect(diagnostics.completeProjects).toContain("AIクローンプラットフォーム");
    expect(diagnostics.incompleteProjects).toContain("OPT社内利用開始");
    expect(diagnostics.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectName: "OPT社内利用開始",
        missingSections: ["Members And Roles", "Roadmap And Milestones"],
      }),
    ]));
  });
});
