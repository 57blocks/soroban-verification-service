import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { toneDot } from "../constants";
import type { RecentJob } from "../types";
import { formatDateTime, formatDuration, parseTimestamp } from "../utils/duration.util";
import { getRecentJobTone, getTargetSummary } from "../utils/result.util";

/** How long this job took, from the two timestamps the entry already stored. */
const settledDuration = (job: RecentJob): string | null => {
  if (job.status === "queued" || job.status === "running") return null;
  const started = parseTimestamp(job.created_at);
  const ended = parseTimestamp(job.updated_at);
  if (started === undefined || ended === undefined || ended < started) return null;
  return formatDuration(ended - started);
};

const badgeVariant = {
  success: "success",
  warning: "warning",
  danger: "danger",
} as const;

/** Jobs this browser has seen. Kept in localStorage — there is no per-user account. */
export const RecentJobsCard = ({ jobs }: { jobs: RecentJob[] }) => (
  <section className="mt-8 rounded-lg bg-surface p-5 shadow-panel">
    <h2 className="m-0 font-display text-[1.35rem] font-semibold">
      Recent verification jobs
    </h2>
    <p className="m-0 mt-1 text-[0.875rem] leading-[1.5] text-ink/[0.66]">
      Submitted jobs are saved in this browser for quick status checks.
    </p>

    {jobs.length > 0 && (
      <div className="mt-4 rounded-lg bg-surface-alt p-1.5">
        {jobs.map((job) => {
          const tone = getRecentJobTone(job.status);
          const target = getTargetSummary(job.target);
          const duration = settledDuration(job);
          const startedMs = parseTimestamp(job.created_at);

          return (
            <Link
              key={job.job_id}
              to="/verify/jobs/$job_id"
              params={{ job_id: job.job_id }}
              className="grid gap-2 rounded-md px-2.5 py-2 text-ink transition-colors hover:bg-surface md:grid-cols-[1fr_220px] md:items-center"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={["size-2.5 shrink-0 rounded-full", toneDot[tone]].join(
                      " ",
                    )}
                  />
                  <span className="shrink-0 text-[0.75rem] font-semibold uppercase text-ink-warm">
                    {target.kind}
                  </span>
                  <span
                    className="truncate text-[0.875rem] font-medium text-ink-value"
                    title={target.title}
                  >
                    {target.value}
                  </span>
                </div>
                {job.detail && (
                  <div className="mt-1 truncate text-[0.75rem] text-ink/60">
                    {job.detail}
                  </div>
                )}
                {startedMs !== undefined && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.75rem] text-ink-warm">
                    <time dateTime={new Date(startedMs).toISOString()}>
                      {formatDateTime(startedMs)}
                    </time>
                    {duration && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">took {duration}</span>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 md:justify-end">
                <Badge variant={badgeVariant[tone]}>{job.status}</Badge>
                <span className="font-mono text-[0.75rem] text-ink-warm">
                  {job.job_id.slice(0, 8)}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    )}
  </section>
);
