import { Loader2 } from "lucide-react";
import type { JobTiming } from "../types";
import { formatDuration, formatTimestamp } from "../utils/duration.util";
import { MonoLabel } from "./MonoLabel";

type JobTimingCardProps = {
  timing: JobTiming | null;
};

const TIMING_NOTE =
  "Measured from when the verifier accepted this submission, so time spent waiting for a build slot is included in the total.";

export const JobTimingCard = ({ timing }: JobTimingCardProps) => {
  if (!timing) return null;

  const { startedMs, updatedMs, elapsedMs, isRunning, finishIsExact } = timing;
  const approximate = !isRunning && !finishIsExact && updatedMs !== undefined;

  return (
    <section
      data-testid="job-timing"
      title={approximate ? `${TIMING_NOTE} This job did not record when it finished, so the total is an upper bound.` : TIMING_NOTE}
      className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-line bg-surface px-5 py-3 shadow-panel"
    >
      <MonoLabel>Build timing</MonoLabel>
      <span className="inline-flex flex-wrap items-center font-mono text-[12px] tabular-nums text-ink">
        <time className="whitespace-nowrap" dateTime={new Date(startedMs).toISOString()}>{formatTimestamp(startedMs)}</time>
        <span className="whitespace-pre text-ink-mute"> ~ </span>
        {isRunning ? (
          <span className="inline-flex items-center gap-1.5 text-ink-mute">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            in progress
          </span>
        ) : updatedMs === undefined ? (
          <span className="text-ink-mute">not recorded</span>
        ) : (
          <time className="whitespace-nowrap" dateTime={new Date(updatedMs).toISOString()}>{formatTimestamp(updatedMs)}</time>
        )}
      </span>
      <span
        data-testid="job-timing-elapsed"
        className="rounded-md bg-surface-alt px-2 py-0.5 font-mono text-[12px] font-semibold tabular-nums text-ink"
      >
        {approximate && <span className="font-normal text-ink-mute">at most </span>}
        {formatDuration(elapsedMs)}
      </span>
      <span className="sr-only">{TIMING_NOTE}</span>
    </section>
  );
};
