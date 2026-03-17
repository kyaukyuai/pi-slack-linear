import type { Logger } from "./logger.js";
import type { SchedulerJob, SystemPaths } from "./system-workspace.js";
import { loadSchedulerJobs, saveSchedulerJobs } from "./system-workspace.js";

export interface SchedulerExecutionContext {
  job: SchedulerJob;
}

export interface SchedulerExecutionResult {
  delivered: boolean;
  summary: string;
}

export interface SchedulerServiceOptions {
  logger: Logger;
  systemPaths: SystemPaths;
  pollSec: number;
  executeJob: (context: SchedulerExecutionContext) => Promise<SchedulerExecutionResult>;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY_INDEX: Record<NonNullable<SchedulerJob["weekday"]>, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
};

function nowIso(): string {
  return new Date().toISOString();
}

function toJstDateParts(now: Date): { year: number; month: number; day: number; weekday: number } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    weekday: jst.getUTCDay(),
  };
}

function buildUtcFromJstParts(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hours - 9, minutes, 0, 0));
}

function parseTime(value: string): { hours: number; minutes: number } {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return { hours, minutes };
}

function nextDailyRunAt(time: string, now = new Date()): string {
  const { year, month, day } = toJstDateParts(now);
  const { hours, minutes } = parseTime(time);
  let target = buildUtcFromJstParts(year, month, day, hours, minutes);
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  return target.toISOString();
}

function nextWeeklyRunAt(weekday: NonNullable<SchedulerJob["weekday"]>, time: string, now = new Date()): string {
  const { year, month, day, weekday: today } = toJstDateParts(now);
  const { hours, minutes } = parseTime(time);
  const targetWeekday = WEEKDAY_INDEX[weekday];
  let dayOffset = (targetWeekday - today + 7) % 7;

  let target = buildUtcFromJstParts(year, month, day + dayOffset, hours, minutes);
  if (target.getTime() <= now.getTime()) {
    dayOffset += dayOffset === 0 ? 7 : 0;
    if (dayOffset === 0) {
      dayOffset = 7;
    }
    target = buildUtcFromJstParts(year, month, day + dayOffset, hours, minutes);
  }

  return target.toISOString();
}

function getInitialNextRunAt(job: SchedulerJob): string | undefined {
  if (job.nextRunAt) return job.nextRunAt;
  if (job.kind === "at") return job.at;
  if (job.kind === "daily" && job.time) return nextDailyRunAt(job.time);
  if (job.kind === "weekly" && job.time && job.weekday) return nextWeeklyRunAt(job.weekday, job.time);
  return job.createdAt ?? nowIso();
}

export function normalizeSchedulerJobs(jobs: SchedulerJob[]): SchedulerJob[] {
  const now = nowIso();

  return jobs.map((job) => ({
    ...job,
    enabled: job.enabled ?? true,
    createdAt: job.createdAt ?? now,
    updatedAt: job.updatedAt ?? now,
    nextRunAt: getInitialNextRunAt(job),
  }));
}

export function isJobDue(job: SchedulerJob, now = Date.now()): boolean {
  if (!job.enabled) return false;
  if (!job.nextRunAt) return false;
  return Date.parse(job.nextRunAt) <= now;
}

export function advanceJobAfterRun(
  job: SchedulerJob,
  status: "ok" | "error",
  summary: string,
  now = new Date(),
): SchedulerJob {
  const nowIsoValue = now.toISOString();

  if (job.kind === "at") {
    return {
      ...job,
      enabled: false,
      nextRunAt: undefined,
      updatedAt: nowIsoValue,
      lastRunAt: nowIsoValue,
      lastStatus: status,
      lastError: status === "error" ? summary : undefined,
      lastResult: status === "ok" ? summary : undefined,
    };
  }

  if (job.kind === "daily" && job.time) {
    return {
      ...job,
      enabled: true,
      nextRunAt: nextDailyRunAt(job.time, now),
      updatedAt: nowIsoValue,
      lastRunAt: nowIsoValue,
      lastStatus: status,
      lastError: status === "error" ? summary : undefined,
      lastResult: status === "ok" ? summary : undefined,
    };
  }

  if (job.kind === "weekly" && job.time && job.weekday) {
    return {
      ...job,
      enabled: true,
      nextRunAt: nextWeeklyRunAt(job.weekday, job.time, now),
      updatedAt: nowIsoValue,
      lastRunAt: nowIsoValue,
      lastStatus: status,
      lastError: status === "error" ? summary : undefined,
      lastResult: status === "ok" ? summary : undefined,
    };
  }

  return {
    ...job,
    enabled: true,
    nextRunAt: new Date(now.getTime() + (job.everySec ?? 0) * 1000).toISOString(),
    updatedAt: nowIsoValue,
    lastRunAt: nowIsoValue,
    lastStatus: status,
    lastError: status === "error" ? summary : undefined,
    lastResult: status === "ok" ? summary : undefined,
  };
}

export class SchedulerService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: SchedulerServiceOptions) {}

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollSec * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const loadedJobs = await loadSchedulerJobs(this.options.systemPaths);
      const jobs = normalizeSchedulerJobs(loadedJobs);
      if (JSON.stringify(loadedJobs) !== JSON.stringify(jobs)) {
        await saveSchedulerJobs(this.options.systemPaths, jobs);
      }

      const dueJobs = jobs.filter((job) => isJobDue(job));
      if (dueJobs.length === 0) {
        return;
      }

      let mutatedJobs = jobs;
      for (const dueJob of dueJobs) {
        try {
          const result = await this.options.executeJob({ job: dueJob });
          mutatedJobs = mutatedJobs.map((job) =>
            job.id === dueJob.id ? advanceJobAfterRun(job, "ok", result.summary) : job,
          );
        } catch (error) {
          const summary = error instanceof Error ? error.message : String(error);
          this.options.logger.error("Scheduled job failed", { jobId: dueJob.id, error: summary });
          mutatedJobs = mutatedJobs.map((job) =>
            job.id === dueJob.id ? advanceJobAfterRun(job, "error", summary) : job,
          );
        }
      }

      await saveSchedulerJobs(this.options.systemPaths, mutatedJobs);
    } finally {
      this.running = false;
    }
  }
}
