import { useEffect, useState } from "react";
import type { JobTiming } from "../types";
import { parseTimestamp } from "../utils/duration.util";

const TICK_MS = 1000;

export const useJobTiming = (
  createdAt: string | undefined,
  updatedAt: string | undefined,
  isRunning: boolean,
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

  const updatedMs = isRunning
    ? lastChangeMs
    : (completedMs ?? verifiedMs ?? finishedMs ?? lastChangeMs);

  const endMs = isRunning || updatedMs === undefined ? now : updatedMs;

  return {
    startedMs,
    ...(updatedMs === undefined ? {} : { updatedMs }),
    elapsedMs: Math.max(0, endMs - startedMs),
    isRunning,
    finishIsExact: !isRunning && (completedMs ?? verifiedMs) !== undefined,
  };
};
