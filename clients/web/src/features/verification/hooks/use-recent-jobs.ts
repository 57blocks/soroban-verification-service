import { useSyncExternalStore } from "react";
import {
  EMPTY_RECENT_JOBS,
  readRecentJobs,
  subscribeToRecentJobs,
} from "../utils/recent-jobs.store";

const getServerSnapshot = () => EMPTY_RECENT_JOBS;

/** The jobs this browser has submitted or visited, newest first. */
export const useRecentJobs = () =>
  useSyncExternalStore(
    subscribeToRecentJobs,
    readRecentJobs,
    getServerSnapshot,
  );
