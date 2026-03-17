import { mkdirSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ThreadPaths {
  rootDir: string;
  sessionFile: string;
  logFile: string;
  attachmentsDir: string;
  scratchDir: string;
}

export interface AttachmentRecord {
  id?: string;
  name: string;
  mimeType?: string;
  storedPath: string;
}

export interface LogEntry {
  type: "user" | "assistant" | "system";
  ts: string;
  threadTs: string;
  userId?: string;
  text: string;
  attachments?: AttachmentRecord[];
}

export function buildThreadPaths(workspaceDir: string, channelId: string, rootThreadTs: string): ThreadPaths {
  const safeThreadTs = rootThreadTs.replace(/\./g, "_");
  const rootDir = join(workspaceDir, "threads", channelId, safeThreadTs);
  return {
    rootDir,
    sessionFile: join(rootDir, "session.jsonl"),
    logFile: join(rootDir, "log.jsonl"),
    attachmentsDir: join(rootDir, "attachments"),
    scratchDir: join(rootDir, "scratch"),
  };
}

export async function ensureThreadWorkspace(paths: ThreadPaths): Promise<void> {
  await mkdir(paths.attachmentsDir, { recursive: true });
  await mkdir(paths.scratchDir, { recursive: true });
  mkdirSync(dirname(paths.sessionFile), { recursive: true });
}

export async function appendThreadLog(paths: ThreadPaths, entry: LogEntry): Promise<void> {
  await appendFile(paths.logFile, `${JSON.stringify({ ...entry, createdAt: new Date().toISOString() })}\n`, "utf8");
}

export async function copyBundledSkill(sourceDir: string, destinationDir: string): Promise<void> {
  const sourceStats = await stat(sourceDir);
  if (!sourceStats.isDirectory()) {
    throw new Error(`Skill source is not a directory: ${sourceDir}`);
  }

  await mkdir(destinationDir, { recursive: true });
  const items = await readdir(sourceDir, { withFileTypes: true });

  for (const item of items) {
    const from = join(sourceDir, item.name);
    const to = join(destinationDir, item.name);

    if (item.isDirectory()) {
      await copyBundledSkill(from, to);
      continue;
    }

    if (item.isFile()) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

export async function ensureAgentSkill(bundledSkillDir: string, workspaceDir: string): Promise<string> {
  const agentSkillDir = join(workspaceDir, ".pi", "agent", "skills", "linear-cli");
  await copyBundledSkill(bundledSkillDir, agentSkillDir);
  return agentSkillDir;
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
