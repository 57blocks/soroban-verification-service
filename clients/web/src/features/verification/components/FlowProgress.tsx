import { cn } from "@/lib/utils";
import { flowSteps } from "../constants";

type FlowProgressProps = {
  currentStep: number;
  isFailed: boolean;
  allComplete: boolean;
};

const TickCircle = () => (
  <svg aria-hidden viewBox="0 0 24 24" className="block size-7 shrink-0">
    <circle cx="12" cy="12" r="10" className="fill-yellow" />
    <path
      d="M7.75 12l2.83 2.83 5.67-5.66"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-ink"
    />
  </svg>
);

export const FlowProgress = ({
  currentStep,
  isFailed,
  allComplete,
}: FlowProgressProps) => (
  <section className="mb-5 rounded-xl border border-line bg-surface p-4 shadow-panel">
    <div className="grid gap-3 md:grid-cols-3">
      {flowSteps.map(({ label }, index) => {
        const isComplete = allComplete || currentStep > index;
        const isCurrent = currentStep === index && !isFailed;
        const isStepFailed = isFailed && index === 0;
        const isLast = index === flowSteps.length - 1;

        // The marker is the only visual carrier of state, so the state must also be spoken.
        const state = isStepFailed
          ? "Failed"
          : isComplete
            ? "Done"
            : isCurrent
              ? "In progress"
              : "Not started";

        return (
          <div key={label} className="flex items-center gap-2.5">
            {isComplete ? (
              <TickCircle />
            ) : (
              <span
                aria-hidden
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

            <span className="sr-only">{`${state}: `}</span>
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
                aria-hidden
                className={cn(
                  "ml-1 hidden h-0.5 flex-1 rounded-[1px] md:block",
                  isComplete ? "bg-yellow" : "bg-line-soft",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  </section>
);
