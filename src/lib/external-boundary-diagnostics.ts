import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { buildNotionShellCommand, buildSearchNotionArgs } from "./notion.js";

const execFileAsync = promisify(execFile);
const REQUIRED_LINEAR_VERSION = "2.8.0";

export type ExternalBoundaryStatus = "ok" | "warning" | "failed" | "disabled" | "skipped";

export interface ExternalBoundaryStep {
  name: string;
  status: ExternalBoundaryStatus;
  detail: string;
}

export interface LinearBoundaryDiagnostics {
  status: ExternalBoundaryStatus;
  version?: string;
  requiredVersion: string;
  steps: ExternalBoundaryStep[];
}

export interface NotionBoundaryDiagnostics {
  status: ExternalBoundaryStatus;
  sampleShellCommand: string;
  steps: ExternalBoundaryStep[];
}

export interface WebResearchBoundaryDiagnostics {
  status: ExternalBoundaryStatus;
  parserFixtureCommand: string;
  steps: ExternalBoundaryStep[];
}

export interface ExternalBoundaryDiagnostics {
  generatedAt: string;
  overallStatus: ExternalBoundaryStatus;
  linear: LinearBoundaryDiagnostics;
  notion: NotionBoundaryDiagnostics;
  webResearch: WebResearchBoundaryDiagnostics;
  operatorSummary: {
    recommendedAction: string;
    commands: string[];
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  combined: string;
}

interface CommandRunner {
  execFile: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;
}

const defaultCommandRunner: CommandRunner = {
  async execFile(file, args, env) {
    const result = await execFileAsync(file, args, { env });
    const stdout = String(result.stdout ?? "").trim();
    const stderr = String(result.stderr ?? "").trim();
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { stdout, stderr, combined };
  },
};

export async function buildExternalBoundaryDiagnostics(args: {
  config: AppConfig;
  commandRunner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<ExternalBoundaryDiagnostics> {
  const runner = args.commandRunner ?? defaultCommandRunner;
  const env = {
    ...process.env,
    ...args.env,
    LINEAR_API_KEY: args.config.linearApiKey || args.env?.LINEAR_API_KEY,
    LINEAR_WORKSPACE: args.config.linearWorkspace || args.env?.LINEAR_WORKSPACE,
    LINEAR_TEAM_KEY: args.config.linearTeamKey || args.env?.LINEAR_TEAM_KEY,
    NOTION_API_TOKEN: args.config.notionApiToken || args.env?.NOTION_API_TOKEN,
  };

  const [linear, notion] = await Promise.all([
    buildLinearBoundaryDiagnostics(args.config, runner, env),
    buildNotionBoundaryDiagnostics(args.config, runner, env),
  ]);
  const webResearch = buildWebResearchBoundaryDiagnostics();

  const overallStatus = combineStatuses([
    linear.status,
    notion.status,
    webResearch.status,
  ]);

  return {
    generatedAt: new Date().toISOString(),
    overallStatus,
    linear,
    notion,
    webResearch,
    operatorSummary: {
      recommendedAction: buildOperatorSummary(overallStatus),
      commands: [
        "npm run manager:diagnostics -- boundaries /workspace",
        "npm test -- test/web-research.test.ts",
      ],
    },
  };
}

async function buildLinearBoundaryDiagnostics(
  config: AppConfig,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<LinearBoundaryDiagnostics> {
  const steps: ExternalBoundaryStep[] = [];
  const hasAuth = Boolean(env.LINEAR_API_KEY?.trim() || env.LINEAR_WORKSPACE?.trim());
  const hasTeamKey = Boolean(config.linearTeamKey?.trim() || env.LINEAR_TEAM_KEY?.trim());
  let version: string | undefined;

  if (!hasAuth) {
    steps.push({
      name: "auth-configured",
      status: "failed",
      detail: "LINEAR_API_KEY または LINEAR_WORKSPACE が未設定です。",
    });
    return {
      status: "failed",
      requiredVersion: REQUIRED_LINEAR_VERSION,
      steps,
    };
  }

  if (!hasTeamKey) {
    steps.push({
      name: "team-key-configured",
      status: "failed",
      detail: "LINEAR_TEAM_KEY が未設定です。",
    });
    return {
      status: "failed",
      requiredVersion: REQUIRED_LINEAR_VERSION,
      steps,
    };
  }

  try {
    const versionResult = await runner.execFile("linear", ["--version"], env);
    version = extractVersion(versionResult.combined);
    const versionStatus = version && compareVersions(version, REQUIRED_LINEAR_VERSION) >= 0 ? "ok" : "failed";
    steps.push({
      name: "cli-version",
      status: versionStatus,
      detail: version
        ? `linear-cli ${version} を検出しました。required >= ${REQUIRED_LINEAR_VERSION}`
        : `linear --version の出力から version を抽出できませんでした: ${versionResult.combined || "empty output"}`,
    });
    if (versionStatus === "failed") {
      return {
        status: "failed",
        version,
        requiredVersion: REQUIRED_LINEAR_VERSION,
        steps,
      };
    }
  } catch (error) {
    steps.push({
      name: "cli-version",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "failed",
      requiredVersion: REQUIRED_LINEAR_VERSION,
      steps,
    };
  }

  try {
    const whoami = await runner.execFile("linear", ["auth", "whoami"], env);
    steps.push({
      name: "auth-whoami",
      status: whoami.combined ? "ok" : "failed",
      detail: whoami.combined || "linear auth whoami returned empty output",
    });
  } catch (error) {
    steps.push({
      name: "auth-whoami",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const helpCommands = [
    ["issue", "children", "--help"],
    ["issue", "parent", "--help"],
    ["issue", "create-batch", "--help"],
    ["team", "members", "--help"],
    ["webhook", "list", "--help"],
    ["webhook", "create", "--help"],
    ["webhook", "update", "--help"],
  ] as const;
  const helpFailures: string[] = [];
  for (const command of helpCommands) {
    try {
      await runner.execFile("linear", [...command], env);
    } catch (error) {
      helpFailures.push(`${command.join(" ")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  steps.push({
    name: "required-command-surface",
    status: helpFailures.length === 0 ? "ok" : "failed",
    detail: helpFailures.length === 0
      ? "issue children/parent/create-batch, team members, webhook list/create/update が利用可能です。"
      : helpFailures.join(" | "),
  });

  try {
    const teamList = await runner.execFile("linear", ["team", "list"], env);
    const lines = teamList.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const teamKey = config.linearTeamKey || env.LINEAR_TEAM_KEY || "";
    const hasTeam = lines.some((line) => line.startsWith(`${teamKey} `) || line === teamKey);
    steps.push({
      name: "team-list",
      status: hasTeam ? "ok" : "failed",
      detail: hasTeam
        ? `LINEAR_TEAM_KEY ${teamKey} を team list で確認できました。`
        : `LINEAR_TEAM_KEY ${teamKey} が team list 出力に見つかりませんでした。`,
    });
  } catch (error) {
    steps.push({
      name: "team-list",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    status: combineStatuses(steps.map((step) => step.status)),
    version,
    requiredVersion: REQUIRED_LINEAR_VERSION,
    steps,
  };
}

async function buildNotionBoundaryDiagnostics(
  config: AppConfig,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<NotionBoundaryDiagnostics> {
  const sampleShellCommand = buildNotionShellCommand(buildSearchNotionArgs({
    query: "diagnostic",
    pageSize: 1,
  }));
  const steps: ExternalBoundaryStep[] = [];

  if (!config.notionApiToken?.trim() && !env.NOTION_API_TOKEN?.trim()) {
    steps.push({
      name: "notion-integration",
      status: "disabled",
      detail: "NOTION_API_TOKEN が未設定のため Notion integration は無効です。",
    });
    return {
      status: "disabled",
      sampleShellCommand,
      steps,
    };
  }

  try {
    const binaryPath = await runner.execFile("sh", ["-lc", "command -v ntn"], env);
    steps.push({
      name: "ntn-binary",
      status: binaryPath.stdout ? "ok" : "failed",
      detail: binaryPath.stdout || "command -v ntn returned empty output",
    });
  } catch (error) {
    steps.push({
      name: "ntn-binary",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "failed",
      sampleShellCommand,
      steps,
    };
  }

  try {
    await runner.execFile("sh", ["-lc", "ntn --help"], env);
    steps.push({
      name: "ntn-help",
      status: "ok",
      detail: "ntn --help が成功しました。",
    });
  } catch (error) {
    steps.push({
      name: "ntn-help",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  steps.push({
    name: "shell-command-contract",
    status: "ok",
    detail: sampleShellCommand,
  });

  return {
    status: combineStatuses(steps.map((step) => step.status)),
    sampleShellCommand,
    steps,
  };
}

function buildWebResearchBoundaryDiagnostics(): WebResearchBoundaryDiagnostics {
  const steps: ExternalBoundaryStep[] = [
    {
      name: "parser-fixture-coverage",
      status: "ok",
      detail: "DuckDuckGo HTML parser drift は fixture test で検知します。",
    },
    {
      name: "live-network-check",
      status: "skipped",
      detail: "live fetch は diagnostics では実行しません。operator は parser fixture test を優先します。",
    },
  ];

  return {
    status: combineStatuses(steps.map((step) => step.status)),
    parserFixtureCommand: "npm test -- test/web-research.test.ts",
    steps,
  };
}

function buildOperatorSummary(status: ExternalBoundaryStatus): string {
  if (status === "failed") {
    return "外部境界に失敗があります。CLI binary / auth / required command surface を確認してください。";
  }
  if (status === "warning") {
    return "外部境界に警告があります。設定値と optional integration の状態を確認してください。";
  }
  return "外部境界は現時点の lightweight checks では問題ありません。";
}

function combineStatuses(statuses: ExternalBoundaryStatus[]): ExternalBoundaryStatus {
  const severity: Record<ExternalBoundaryStatus, number> = {
    failed: 4,
    warning: 3,
    ok: 2,
    disabled: 1,
    skipped: 0,
  };
  return statuses.reduce<ExternalBoundaryStatus>((current, next) => (
    severity[next] > severity[current] ? next : current
  ), "ok");
}

function extractVersion(raw: string): string | undefined {
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

function normalizeVersion(raw: string): number[] {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
