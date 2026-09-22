import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { flowSteps } from "../constants";

type FlowProgressProps = {
  /** Index of the step in progress; anything past the last step marks them all complete. */
  currentStep: number;
  isFailed: boolean;
  /** An already-published result skips the pipeline entirely, so every step reads complete. */
  allComplete: boolean;
};

/**
 * Where a job has got to, as one rule across the page.
 *
 * It was a panel carrying `01 / 02 / 03` and a caption apiece, standing between the reader and the form while
 * saying nothing a job had not started. The captions are gone, the panel with them, and the caller renders this
 * only once there is job state for it to carry.
 */
export const FlowProgress = ({
  currentStep,
  isFailed,
  allComplete,
}: FlowProgressProps) => (
  <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-line py-2.5 font-mono text-[10px] uppercase tracking-[0.12em]">
    {flowSteps.map(({ label }, index) => {
      const isComplete = allComplete || currentStep > index;
      const isCurrent = currentStep === index && !isFailed;
      // A failure is always reported against the first step — that is where the user acts.
      const isStepFailed = isFailed && index === 0;
      const isLast = index === flowSteps.length - 1;

      // The dot is the only thing carrying the step's state, and a dot is not readable. The tick this
      // replaced was an `<img alt="Done">`, so the state was spoken before; it has to stay spoken.
      const state = isStepFailed
        ? "Failed"
        : isComplete
          ? "Done"
          : isCurrent
            ? "In progress"
            : "Not started";

      return (
        <Fragment key={label}>
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isStepFailed
                  ? "bg-danger-fg"
                  : isComplete
                    ? "bg-success-fg"
                    : isCurrent
                      ? "bg-ink"
                      : "bg-line-mute",
              )}
            />
            <span className="sr-only">{`${state}: `}</span>
            <span
              className={cn(
                "whitespace-nowrap",
                isStepFailed
                  ? "text-danger-fg"
                  : isComplete || isCurrent
                    ? "text-ink"
                    : "text-ink-mute",
              )}
            >
              {label}
            </span>
          </span>

          {!isLast && (
            <span
              aria-hidden
              className={cn(
                "hidden h-px w-8 md:block",
                isComplete ? "bg-ink/25" : "bg-line-soft",
              )}
            />
          )}
        </Fragment>
      );
    })}
  </div>
);
