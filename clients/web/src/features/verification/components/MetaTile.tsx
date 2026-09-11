import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MutedLabel } from "./MutedLabel";

type MetaTileProps = {
  label: ReactNode;
  value: ReactNode;
  /** Present only on comparison tiles, which keep their value on one line above the detail. */
  detail?: ReactNode;
  /** Comparison tiles colour the value by verdict. */
  valueClassName?: string;
  mono?: boolean;
};

/** One label/value cell of the result, diagnostics, and comparison grids. */
export const MetaTile = ({
  label,
  value,
  detail,
  valueClassName,
  mono = false,
}: MetaTileProps) => (
  <div className="rounded-md bg-surface-alt p-3">
    <MutedLabel>{label}</MutedLabel>
    <div
      className={cn(
        "mt-1 break-all text-ink",
        detail ? "font-semibold" : "font-medium",
        mono && "font-mono",
        valueClassName,
      )}
    >
      {value}
    </div>
    {detail && (
      <div className="mt-1 break-words text-[0.75rem] leading-[1.5] text-ink-warm">
        {detail}
      </div>
    )}
  </div>
);
