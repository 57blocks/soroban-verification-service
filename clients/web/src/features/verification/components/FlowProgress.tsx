import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { flowSteps } from "../constants";

type FlowProgressProps = {
  currentStep: number;
  isFailed: boolean;
  allComplete: boolean;
};

export const FlowProgress = ({
  currentStep,
  isFailed,
  allComplete,
}: FlowProgressProps) => (
  <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-line py-2.5 font-mono text-[10px] uppercase tracking-[0.12em]">
    {flowSteps.map(({ label }, index) => {
      const isComplete = allComplete || currentStep > index;
      const isCurrent = currentStep === index && !isFailed;
      const isStepFailed = isFailed && index === 0;
      const isLast = index === flowSteps.length - 1;

      // The dot is the only visual carrier of state, so the state must also be spoken.
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
