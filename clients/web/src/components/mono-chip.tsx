import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type MonoSpan = {
  text: string;
  tone?: "verdict" | "mismatch" | "key" | "value";
};

const toneClass: Record<NonNullable<MonoSpan["tone"]>, string> = {
  verdict: "text-success-fg",
  mismatch: "text-danger-fg",
  key: "text-ink-mute",
  value: "text-ink",
};

type MonoChipProps = {
  sample?: string | MonoSpan[];
  children?: ReactNode;
  className?: string;
};

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
