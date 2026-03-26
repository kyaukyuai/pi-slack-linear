import type { ManagerPolicy } from "../state/manager-state-contract.js";
import { DEFAULT_HEARTBEAT_PROMPT } from "./heartbeat.js";
import { normalizeSchedulerJobs } from "./scheduler.js";
import {
  loadSchedulerJobStatuses,
  loadSchedulerJobs,
  readHeartbeatInstructions,
  type SchedulerJob,
  type SchedulerJobStatus,
  type SystemPaths,
} from "./system-workspace.js";

export type BuiltInScheduleId = "morning-review" | "evening-review" | "weekly-review" | "heartbeat";

export interface SchedulerScheduleView {
  id: string;
  kind: "custom-job" | BuiltInScheduleId;
  enabled: boolean;
  channelId: string;
  channelLabel: string;
  scheduleType: SchedulerJob["kind"] | "heartbeat";
  prompt: string;
  time?: string;
  weekday?: SchedulerJob["weekday"];
  everySec?: number;
  at?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: SchedulerJob["lastStatus"];
  lastResult?: string;
  lastError?: string;
  source: "jobs" | "policy";
  intervalMin?: number;
  activeLookbackHours?: number;
}

interface BuiltInReviewDescriptor {
  builtinId: Exclude<BuiltInScheduleId, "heartbeat">;
  jobId: string;
  enabled: (policy: ManagerPolicy) => boolean;
  time: (policy: ManagerPolicy) => string;
  weekday: (policy: ManagerPolicy) => SchedulerJob["weekday"] | undefined;
  prompt: string;
  action: NonNullable<SchedulerJob["action"]>;
  scheduleType: SchedulerJob["kind"];
}

const BUILT_IN_REVIEW_DESCRIPTORS: BuiltInReviewDescriptor[] = [
  {
    builtinId: "morning-review",
    jobId: "manager-review-morning",
    enabled: (policy) => policy.reviewCadence.morningEnabled,
    time: (policy) => policy.reviewCadence.morning,
    weekday: () => undefined,
    prompt: "manager review: morning",
    action: "morning-review",
    scheduleType: "daily",
  },
  {
    builtinId: "evening-review",
    jobId: "manager-review-evening",
    enabled: (policy) => policy.reviewCadence.eveningEnabled,
    time: (policy) => policy.reviewCadence.evening,
    weekday: () => undefined,
    prompt: "manager review: evening",
    action: "evening-review",
    scheduleType: "daily",
  },
  {
    builtinId: "weekly-review",
    jobId: "manager-review-weekly",
    enabled: (policy) => policy.reviewCadence.weeklyEnabled,
    time: (policy) => policy.reviewCadence.weeklyTime,
    weekday: (policy) => policy.reviewCadence.weeklyDay,
    prompt: "manager review: weekly",
    action: "weekly-review",
    scheduleType: "weekly",
  },
];

export const BUILT_IN_REVIEW_JOB_IDS = BUILT_IN_REVIEW_DESCRIPTORS.map((descriptor) => descriptor.jobId);
export const BUILT_IN_SCHEDULE_IDS: BuiltInScheduleId[] = [
  ...BUILT_IN_REVIEW_DESCRIPTORS.map((descriptor) => descriptor.builtinId),
  "heartbeat",
];

function channelLabel(channelId: string, policy: ManagerPolicy): string {
  return channelId === policy.controlRoomChannelId ? "control-room" : channelId;
}

function descriptorForBuiltInId(
  builtinId: Exclude<BuiltInScheduleId, "heartbeat">,
): BuiltInReviewDescriptor | undefined {
  return BUILT_IN_REVIEW_DESCRIPTORS.find((descriptor) => descriptor.builtinId === builtinId);
}

function descriptorForJobId(jobId: string): BuiltInReviewDescriptor | undefined {
  return BUILT_IN_REVIEW_DESCRIPTORS.find((descriptor) => descriptor.jobId === jobId);
}

export function builtInScheduleIdForJobId(jobId: string): BuiltInScheduleId | undefined {
  return descriptorForJobId(jobId)?.builtinId;
}

export function reviewJobIdForBuiltInScheduleId(
  builtinId: Exclude<BuiltInScheduleId, "heartbeat">,
): string {
  return descriptorForBuiltInId(builtinId)?.jobId ?? builtinId;
}

export function isBuiltInReviewJobId(jobId: string): boolean {
  return BUILT_IN_REVIEW_JOB_IDS.includes(jobId);
}

export function isBuiltInScheduleId(id: string): id is BuiltInScheduleId {
  return BUILT_IN_SCHEDULE_IDS.includes(id as BuiltInScheduleId);
}

export function isReservedSchedulerId(id: string): boolean {
  return id === "heartbeat" || isBuiltInReviewJobId(id);
}

function mergeSchedulerJob(existing: SchedulerJob | undefined, desired: SchedulerJob): SchedulerJob {
  if (!existing) {
    return desired;
  }

  return {
    ...existing,
    enabled: desired.enabled,
    channelId: desired.channelId,
    prompt: desired.prompt,
    kind: desired.kind,
    time: desired.time,
    weekday: desired.weekday,
    action: desired.action,
    at: desired.at,
    everySec: desired.everySec,
  };
}

export function buildManagerReviewJobs(policy: ManagerPolicy): SchedulerJob[] {
  return BUILT_IN_REVIEW_DESCRIPTORS
    .filter((descriptor) => descriptor.enabled(policy))
    .map((descriptor) => ({
      id: descriptor.jobId,
      enabled: true,
      channelId: policy.controlRoomChannelId,
      prompt: descriptor.prompt,
      kind: descriptor.scheduleType,
      time: descriptor.time(policy),
      weekday: descriptor.weekday(policy),
      action: descriptor.action,
    }));
}

export function syncBuiltInReviewJobs(policy: ManagerPolicy, jobs: SchedulerJob[]): SchedulerJob[] {
  const existingById = new Map(jobs.map((job) => [job.id, job]));
  const customJobs = jobs.filter((job) => !isBuiltInReviewJobId(job.id));
  const desiredJobs = buildManagerReviewJobs(policy).map((desiredJob) => (
    mergeSchedulerJob(existingById.get(desiredJob.id), desiredJob)
  ));
  return [...customJobs, ...desiredJobs];
}

function applySchedulerJobStatuses(
  jobs: SchedulerJob[],
  statuses: SchedulerJobStatus[],
): SchedulerJob[] {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return jobs.map((job) => ({
    ...job,
    ...(statusById.get(job.id) ?? {}),
  }));
}

export async function loadExecutableSchedulerJobs(
  paths: SystemPaths,
  policy: ManagerPolicy,
): Promise<SchedulerJob[]> {
  const [customJobs, statuses] = await Promise.all([
    loadSchedulerJobs(paths),
    loadSchedulerJobStatuses(paths),
  ]);

  const builtInJobs = buildManagerReviewJobs(policy);
  return [
    ...normalizeSchedulerJobs(customJobs),
    ...normalizeSchedulerJobs(applySchedulerJobStatuses(builtInJobs, statuses)),
  ];
}

function buildCustomScheduleView(job: SchedulerJob, policy: ManagerPolicy): SchedulerScheduleView {
  return {
    id: job.id,
    kind: "custom-job",
    enabled: job.enabled,
    channelId: job.channelId,
    channelLabel: channelLabel(job.channelId, policy),
    scheduleType: job.kind,
    prompt: job.prompt,
    time: job.time,
    weekday: job.weekday,
    everySec: job.everySec,
    at: job.at,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastResult: job.lastResult,
    lastError: job.lastError,
    source: "jobs",
  };
}

function buildBuiltInReviewView(
  descriptor: BuiltInReviewDescriptor,
  policy: ManagerPolicy,
  matchingJob?: SchedulerJob,
): SchedulerScheduleView {
  return {
    id: descriptor.jobId,
    kind: descriptor.builtinId,
    enabled: descriptor.enabled(policy),
    channelId: policy.controlRoomChannelId,
    channelLabel: channelLabel(policy.controlRoomChannelId, policy),
    scheduleType: descriptor.scheduleType,
    prompt: matchingJob?.prompt ?? descriptor.prompt,
    time: descriptor.time(policy),
    weekday: descriptor.weekday(policy),
    nextRunAt: matchingJob?.nextRunAt,
    lastRunAt: matchingJob?.lastRunAt,
    lastStatus: matchingJob?.lastStatus,
    lastResult: matchingJob?.lastResult,
    lastError: matchingJob?.lastError,
    source: "policy",
  };
}

function buildHeartbeatView(policy: ManagerPolicy, prompt: string): SchedulerScheduleView {
  return {
    id: "heartbeat",
    kind: "heartbeat",
    enabled: policy.heartbeatEnabled,
    channelId: policy.controlRoomChannelId,
    channelLabel: channelLabel(policy.controlRoomChannelId, policy),
    scheduleType: "heartbeat",
    prompt,
    everySec: policy.heartbeatIntervalMin * 60,
    source: "policy",
    intervalMin: policy.heartbeatIntervalMin,
    activeLookbackHours: policy.heartbeatActiveLookbackHours,
  };
}

function compareSchedules(left: SchedulerScheduleView, right: SchedulerScheduleView): number {
  const builtInLeft = left.source === "policy" ? 0 : 1;
  const builtInRight = right.source === "policy" ? 0 : 1;
  return builtInLeft - builtInRight || left.id.localeCompare(right.id);
}

export async function listUnifiedSchedules(
  paths: SystemPaths,
  policy: ManagerPolicy,
  options?: {
    channelId?: string;
  },
): Promise<SchedulerScheduleView[]> {
  const channelId = options?.channelId ?? policy.controlRoomChannelId;
  const jobs = await loadExecutableSchedulerJobs(paths, policy);
  const heartbeatPrompt = (await readHeartbeatInstructions(paths)) ?? DEFAULT_HEARTBEAT_PROMPT;
  const customViews = jobs
    .filter((job) => !isBuiltInReviewJobId(job.id))
    .map((job) => buildCustomScheduleView(job, policy));
  const builtInViews = [
    ...BUILT_IN_REVIEW_DESCRIPTORS.map((descriptor) => buildBuiltInReviewView(
      descriptor,
      policy,
      jobs.find((job) => job.id === descriptor.jobId),
    )),
    buildHeartbeatView(policy, heartbeatPrompt),
  ];

  return [...builtInViews, ...customViews]
    .filter((view) => view.channelId === channelId)
    .sort(compareSchedules);
}

export async function getUnifiedSchedule(
  paths: SystemPaths,
  policy: ManagerPolicy,
  id: string,
): Promise<SchedulerScheduleView | undefined> {
  const jobs = await loadExecutableSchedulerJobs(paths, policy);
  if (id === "heartbeat") {
    const heartbeatPrompt = (await readHeartbeatInstructions(paths)) ?? DEFAULT_HEARTBEAT_PROMPT;
    return buildHeartbeatView(policy, heartbeatPrompt);
  }

  if (isBuiltInScheduleId(id)) {
    if (id === "heartbeat") {
      const heartbeatPrompt = (await readHeartbeatInstructions(paths)) ?? DEFAULT_HEARTBEAT_PROMPT;
      return buildHeartbeatView(policy, heartbeatPrompt);
    }
    const descriptor = descriptorForBuiltInId(id);
    if (!descriptor) {
      return undefined;
    }
    return buildBuiltInReviewView(
      descriptor,
      policy,
      jobs.find((job) => job.id === descriptor.jobId),
    );
  }

  if (isBuiltInReviewJobId(id)) {
    const descriptor = descriptorForJobId(id);
    if (!descriptor) {
      return undefined;
    }
    return buildBuiltInReviewView(
      descriptor,
      policy,
      jobs.find((job) => job.id === descriptor.jobId),
    );
  }

  const job = jobs.find((entry) => entry.id === id);
  return job ? buildCustomScheduleView(job, policy) : undefined;
}
