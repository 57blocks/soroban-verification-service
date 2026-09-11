import { useEffect, useState } from "react";
import type { JobTiming } from "../types";
import { parseTimestamp } from "../utils/duration.util";

/** One second. A verification runs for minutes, so anything finer is a re-render nobody can read. */
const TICK_MS = 1000;

/** The job's timing, as the console shows it. */
export const useJobTiming = (
  createdAt: string | undefined,
  updatedAt: string | undefined,
  isRunning: boolean,
  /** The frozen instant this job settled, where this browser recorded one. */
  finishedAt?: string,
  verifiedAt?: string,
  completedAt?: string,
): JobTiming | null => {
  const startedMs = parseTimestamp(createdAt);
  const lastChangeMs = parseTimestamp(updatedAt);
  const finishedMs = parseTimestamp(finishedAt);
  const completedMs = parseTimestamp(completedAt);
  const rawVerifiedMs = parseTimestamp(verifiedAt);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning || startedMs === undefined) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [isRunning, startedMs]);

  if (startedMs === undefined) return null;

  // An adopted result's `verified_at` is the donor's and can predate this job.
  const verifiedMs =
    rawVerifiedMs !== undefined && rawVerifiedMs >= startedMs ? rawVerifiedMs : undefined;

  // While running, the third tile is "Last update" and `updated_at` is exactly that.
  const updatedMs = isRunning
    ? lastChangeMs
    : (completedMs ?? verifiedMs ?? finishedMs ?? lastChangeMs);

  // A settled job with no timestamp at all falls back to the live clock rather than to `startedMs`: "we did not
  // record when it finished" must not render as "it took 0s".
  const endMs = isRunning || updatedMs === undefined ? now : updatedMs;

  return {
    startedMs,
    ...(updatedMs === undefined ? {} : { updatedMs }),
    elapsedMs: Math.max(0, endMs - startedMs),
    isRunning,
    // Only the server's own instant makes the total exact; the card labels the rest "at most".
    finishIsExact: !isRunning && (completedMs ?? verifiedMs) !== undefined,
  };
};
