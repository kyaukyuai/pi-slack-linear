import { describe, expect, it } from "vitest";
import { advanceJobAfterRun, isJobDue, normalizeSchedulerJobs } from "../src/lib/scheduler.js";

describe("scheduler helpers", () => {
  it("normalizes missing timestamps and nextRunAt", () => {
    const [job] = normalizeSchedulerJobs([
      {
        id: "job-1",
        enabled: true,
        channelId: "C123",
        prompt: "hello",
        kind: "at",
        at: "2026-03-18T00:00:00.000Z",
      },
    ]);

    expect(job.nextRunAt).toBe("2026-03-18T00:00:00.000Z");
    expect(job.createdAt).toBeTruthy();
    expect(job.updatedAt).toBeTruthy();
  });

  it("detects due jobs", () => {
    expect(
      isJobDue({
        id: "job-1",
        enabled: true,
        channelId: "C123",
        prompt: "hello",
        kind: "at",
        at: "2026-03-18T00:00:00.000Z",
        nextRunAt: "2026-03-18T00:00:00.000Z",
      }, Date.parse("2026-03-18T00:00:01.000Z")),
    ).toBe(true);
  });

  it("disables one-shot jobs after a run", () => {
    const updated = advanceJobAfterRun(
      {
        id: "job-1",
        enabled: true,
        channelId: "C123",
        prompt: "hello",
        kind: "at",
        at: "2026-03-18T00:00:00.000Z",
        nextRunAt: "2026-03-18T00:00:00.000Z",
      },
      "ok",
      "done",
      new Date("2026-03-18T00:00:05.000Z"),
    );

    expect(updated.enabled).toBe(false);
    expect(updated.nextRunAt).toBeUndefined();
    expect(updated.lastStatus).toBe("ok");
  });

  it("advances recurring jobs by everySec", () => {
    const updated = advanceJobAfterRun(
      {
        id: "job-1",
        enabled: true,
        channelId: "C123",
        prompt: "hello",
        kind: "every",
        everySec: 60,
        nextRunAt: "2026-03-18T00:00:00.000Z",
      },
      "ok",
      "done",
      new Date("2026-03-18T00:00:05.000Z"),
    );

    expect(updated.enabled).toBe(true);
    expect(updated.nextRunAt).toBe("2026-03-18T00:01:05.000Z");
  });

  it("initializes daily jobs to the next JST run", () => {
    const [job] = normalizeSchedulerJobs([
      {
        id: "job-daily",
        enabled: true,
        channelId: "C123",
        prompt: "morning review",
        kind: "daily",
        time: "09:00",
      },
    ]);

    expect(job.nextRunAt).toBeTruthy();
  });

  it("advances daily jobs to the next fixed JST time", () => {
    const updated = advanceJobAfterRun(
      {
        id: "job-daily",
        enabled: true,
        channelId: "C123",
        prompt: "morning review",
        kind: "daily",
        time: "09:00",
        nextRunAt: "2026-03-18T00:00:00.000Z",
      },
      "ok",
      "done",
      new Date("2026-03-18T00:05:00.000Z"),
    );

    expect(updated.nextRunAt).toBe("2026-03-19T00:00:00.000Z");
  });

  it("advances weekly jobs to the next fixed JST weekday", () => {
    const updated = advanceJobAfterRun(
      {
        id: "job-weekly",
        enabled: true,
        channelId: "C123",
        prompt: "weekly review",
        kind: "weekly",
        weekday: "mon",
        time: "09:30",
        nextRunAt: "2026-03-16T00:30:00.000Z",
      },
      "ok",
      "done",
      new Date("2026-03-16T00:35:00.000Z"),
    );

    expect(updated.nextRunAt).toBe("2026-03-23T00:30:00.000Z");
  });
});
