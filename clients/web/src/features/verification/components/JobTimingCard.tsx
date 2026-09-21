import { Loader2 } from "lucide-react";
import type { JobTiming } from "../types";
import { formatDateTime, formatDuration } from "../utils/duration.util";
import { MetaTile } from "./MetaTile";
import { MutedLabel } from "./MutedLabel";

type JobTimingCardProps = {
  timing: JobTiming | null;
};

/** When this job started and how long it has taken. */
export const JobTimingCard = ({ timing }: JobTimingCardProps) => {
  if (!timing) return null;

  const { startedMs, updatedMs, elapsedMs, isRunning, finishIsExact } = timing;
  // A total that fell back to `updated_at` is an upper bound, not a measurement — see `useJobTiming`.
  const approximate = !isRunning && !finishIsExact && updatedMs !== undefined;

  return (
    <section
      data-testid="job-timing"
      className="mb-5 rounded-xl border border-line bg-surface p-4 shadow-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <MutedLabel>Build timing</MutedLabel>
        {isRunning && (
          <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold text-ink-warm">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            In progress
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <MetaTile
          label="Queued at"
          value={
            <time dateTime={new Date(startedMs).toISOString()}>
              {formatDateTime(startedMs)}
            </time>
          }
        />
        <MetaTile
          label={isRunning ? "Elapsed" : "Total time"}
          value={
            <span data-testid="job-timing-elapsed" className="tabular-nums">
              {approximate && <span className="text-ink-warm">at most </span>}
              {formatDuration(elapsedMs)}
            </span>
          }
          {...(approximate
            ? { detail: "This job did not record when it finished, so the total is an upper bound." }
            : {})}
        />
        <MetaTile
          label={isRunning ? "Last update" : approximate ? "Last write" : "Finished at"}
          value={
            updatedMs === undefined ? (
              <span className="text-ink-warm">Not recorded</span>
            ) : (
              <time dateTime={new Date(updatedMs).toISOString()}>
                {formatDateTime(updatedMs)}
              </time>
            )
          }
        />
      </div>

      <p className="m-0 mt-2 text-[0.75rem] leading-[1.45] text-ink/[0.66]">
        Measured from when the verifier accepted this submission, so time spent waiting for a build
        slot is included in the total.
      </p>
    </section>
  );
};
