import { sortBy, uniqBy } from "es-toolkit";
import type { RecentJob } from "../types";

const LAST_JOB_KEY = "scvs:lastJobId";
const RECENT_JOBS_KEY = "scvs:recentJobs";
const RECENT_JOBS_CHANGED_EVENT = "scvs:recentJobsChanged";
const MAX_RECENT_JOBS = 8;

const sortRecentJobs = (jobs: RecentJob[]): RecentJob[] =>
  sortBy(jobs, [
    (job) => -(Date.parse(job.created_at || job.updated_at || "") || 0),
  ]);

// Stable reference for `useSyncExternalStore`'s snapshot.
export const EMPTY_RECENT_JOBS: RecentJob[] = [];
let cachedRecentJobsRaw: string | null = null;
let cachedRecentJobs: RecentJob[] = EMPTY_RECENT_JOBS;

export const readRecentJobs = (): RecentJob[] => {
  if (typeof window === "undefined") return EMPTY_RECENT_JOBS;
  try {
    const raw = window.localStorage.getItem(RECENT_JOBS_KEY);
    if (!raw) return EMPTY_RECENT_JOBS;
    if (raw === cachedRecentJobsRaw) return cachedRecentJobs;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_RECENT_JOBS;
    const normalized: RecentJob[] = parsed.map((item: RecentJob) => ({
      ...item,
      created_at: item.created_at || item.updated_at,
    }));
    cachedRecentJobsRaw = raw;
    cachedRecentJobs = sortRecentJobs(normalized).slice(0, MAX_RECENT_JOBS);
    return cachedRecentJobs;
  } catch {
    return EMPTY_RECENT_JOBS;
  }
};

const writeRecentJobs = (jobs: RecentJob[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      RECENT_JOBS_KEY,
      JSON.stringify(sortRecentJobs(jobs).slice(0, MAX_RECENT_JOBS)),
    );
  } catch {
    /* empty */
  }
};

export const rememberJob = (job: RecentJob) => {
  if (typeof window === "undefined") return;
  const jobs = readRecentJobs();
  const existing = jobs.find((item) => item.job_id === job.job_id);
  const merged: RecentJob = {
    ...job,
    created_at: existing?.created_at || job.created_at,
    // Write-once: a later `updated_at` is a later write to a finished row, not a later finish.
    ...(existing?.finished_at || job.finished_at
      ? { finished_at: existing?.finished_at || job.finished_at }
      : {}),
  };
  const next = sortRecentJobs(
    uniqBy([merged, ...jobs], (item) => item.job_id),
  ).slice(0, MAX_RECENT_JOBS);
  try {
    window.localStorage.setItem(LAST_JOB_KEY, job.job_id);
  } catch {
    /* empty */
  }
  writeRecentJobs(next);
  window.dispatchEvent(new Event(RECENT_JOBS_CHANGED_EVENT));
};

export const subscribeToRecentJobs = (
  onStoreChange: () => void,
): (() => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(RECENT_JOBS_CHANGED_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(RECENT_JOBS_CHANGED_EVENT, onStoreChange);
};
