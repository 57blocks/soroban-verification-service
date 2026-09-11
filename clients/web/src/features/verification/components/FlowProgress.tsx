import { cn } from "@/lib/utils";
import { flowSteps } from "../constants";

type FlowProgressProps = {
  /** Index of the step in progress; anything past the last step marks them all complete. */
  currentStep: number;
  isFailed: boolean;
  /** An already-published result skips the pipeline entirely, so every step reads complete. */
  allComplete: boolean;
  /**
   * The per-step captions instruct a submitter about a form ahead of them, so they are off on a job page, where
   * there is no form.
   */
  showDescriptions?: boolean;
};

/** The three-stage tracker across the top of both console pages. */
export const FlowProgress = ({
  currentStep,
  isFailed,
  allComplete,
  showDescriptions = true,
}: FlowProgressProps) => (
  <section className="mb-5 rounded-lg bg-surface p-4 shadow-panel">
    <div className="grid gap-3 md:grid-cols-3">
      {flowSteps.map(({ label, desc }, index) => {
        const isComplete = allComplete || currentStep > index;
        const isCurrent = currentStep === index && !isFailed;
        // A failure is always reported against the first step — that is where the user acts.
        const isStepFailed = isFailed && index === 0;
        const isLast = index === flowSteps.length - 1;

        return (
          <div key={label} className="grid content-start gap-3">
            <div className="flex items-center gap-2.5">
              {isComplete ? (
                <img
                  src="/tick-circle.svg"
                  alt="Done"
                  className="block size-7 shrink-0"
                />
              ) : (
                <span
                  className={cn(
                    "inline-grid size-[26px] shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[0.68rem] font-bold tracking-[0.04em]",
                    isStepFailed
                      ? "border-danger-fg bg-surface text-danger-fg"
                      : isCurrent
                        ? "border-ink bg-surface text-ink"
                        : "border-line-mute bg-transparent text-ink/40",
                  )}
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
              )}

              <span
                className={cn(
                  "whitespace-nowrap text-[0.9rem] font-semibold",
                  isStepFailed
                    ? "text-danger-fg"
                    : isComplete || isCurrent
                      ? "text-ink"
                      : "text-ink/[0.55]",
                )}
              >
                {label}
              </span>

              {!isLast && (
                <span
                  className={cn(
                    "ml-1 hidden h-0.5 flex-1 rounded-[1px] md:block",
                    isComplete ? "bg-yellow" : "bg-line-soft",
                  )}
                />
              )}
            </div>

            {showDescriptions && (
              <div className="ml-9 text-[0.78rem] leading-[1.5] text-ink/60">
                {desc}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </section>
);
