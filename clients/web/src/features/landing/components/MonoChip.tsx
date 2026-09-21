import type { SampleSpan } from "../content";
import { cn } from "@/lib/utils";

/** What each tone is allowed to mean — see `SampleSpan`. */
const toneClass: Record<NonNullable<SampleSpan["tone"]>, string> = {
  verdict: "text-success-fg",
  mismatch: "text-danger-fg",
  key: "text-ink-mute",
  value: "text-ink",
};

/**
 * The monospace strip under a card: one concrete sample of what that card is talking about. Every value is
 * illustrative, which the section's own copy is responsible for not contradicting.
 */
export const MonoChip = ({
  sample,
  className,
}: {
  sample: string | SampleSpan[];
  className?: string;
}) => (
  <span
    className={cn(
      "mt-auto block whitespace-pre-wrap rounded-md bg-surface-alt px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-body",
      className,
    )}
  >
    {typeof sample === "string"
      ? sample
      : sample.map(({ text, tone }, index) => (
          <span key={index} className={tone && toneClass[tone]}>
            {text}
          </span>
        ))}
  </span>
);
