import { Loader2 } from "lucide-react";
import type { JobTiming } from "../types";
import { formatDateTime, formatDuration } from "../utils/duration.util";
import { MonoLabel } from "./MonoLabel";
import { ValueStrip } from "./ValueStrip";

type JobTimingCardProps = {
  timing: JobTiming | null;
};

export const JobTimingCard = ({ timing }: JobTimingCardProps) => {
  if (!timing) return null;

  const { startedMs, updatedMs, elapsedMs, isRunning, finishIsExact } = timing;
  const approximate = !isRunning && !finishIsExact && updatedMs !== undefined;

  return (
    <section
      data-testid="job-timing"
      className="mb-5 rounded-xl border border-line bg-surface p-5 shadow-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <MonoLabel>Build timing</MonoLabel>
        {isRunning && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            In progress
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <ValueStrip
          label="Queued at"
          value={
            <time dateTime={new Date(startedMs).toISOString()}>
              {formatDateTime(startedMs)}
            </time>
          }
        />
        <ValueStrip
          label={isRunning ? "Elapsed" : "Total time"}
          value={
            <span data-testid="job-timing-elapsed" className="tabular-nums">
              {approximate && <span className="text-ink-mute">at most </span>}
              {formatDuration(elapsedMs)}
            </span>
          }
          {...(approximate
            ? { detail: "This job did not record when it finished, so the total is an upper bound." }
            : {})}
        />
        <ValueStrip
          label={isRunning ? "Last update" : approximate ? "Last write" : "Finished at"}
          value={
            updatedMs === undefined ? (
              <span className="text-ink-mute">Not recorded</span>
            ) : (
              <time dateTime={new Date(updatedMs).toISOString()}>
                {formatDateTime(updatedMs)}
              </time>
            )
          }
        />
      </div>

      <p className="m-0 mt-3 text-[0.75rem] leading-[1.45] text-ink/[0.66]">
        Measured from when the verifier accepted this submission, so time spent waiting for a build
        slot is included in the total.
      </p>
    </section>
  );
};
