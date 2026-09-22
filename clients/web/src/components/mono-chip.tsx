import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One run of a monospace strip, and what its colour means.
 *
 * **Colour marks a verdict, never decoration.** `verdict` and `mismatch` are the two outcome tones; `key` and
 * `value` only separate a field's name from its content. A value with no outcome — whether a source is public,
 * which policy applied — takes no tone, because colouring it would assert a judgement the service does not
 * make.
 */
export type MonoSpan = {
  text: string;
  tone?: "verdict" | "mismatch" | "key" | "value";
};

/** What each tone is allowed to mean — see `MonoSpan`. */
const toneClass: Record<NonNullable<MonoSpan["tone"]>, string> = {
  verdict: "text-success-fg",
  mismatch: "text-danger-fg",
  key: "text-ink-mute",
  value: "text-ink",
};

type MonoChipProps = {
  /** The strip's content as data. On the landing page every value is illustrative; in the console none are. */
  sample?: string | MonoSpan[];
  /** For a value that is not plain text — a link, a `<time>` — rendered in the same strip. */
  children?: ReactNode;
  className?: string;
};

/**
 * The monospace strip: one concrete value, set apart from the prose around it. On the landing page it carries a
 * sample of what a card is talking about; in the console it carries the real evidence.
 */
export const MonoChip = ({ sample, children, className }: MonoChipProps) => (
  <span
    className={cn(
      "mt-auto block whitespace-pre-wrap break-words rounded-md bg-surface-alt px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-body",
      className,
    )}
  >
    {children ??
      (typeof sample === "string"
        ? sample
        : sample?.map(({ text, tone }, index) => (
            <span key={index} className={tone && toneClass[tone]}>
              {text}
            </span>
          )))}
  </span>
);
