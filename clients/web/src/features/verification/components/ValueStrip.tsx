import type { ReactNode } from "react";
import { MonoChip } from "@/components/mono-chip";
import { cn } from "@/lib/utils";
import { MonoLabel } from "./MonoLabel";

type ValueStripProps = {
  label: ReactNode;
  value: ReactNode;
  /** A second line under the strip: what the value was compared against, or why it is approximate. */
  detail?: ReactNode;
  /** Comparison strips colour the value by verdict — and nothing else here does. */
  valueClassName?: string;
};

/**
 * One label over one value, the value in the landing page's monospace strip. Every grid in the result — the
 * comparison, the build inputs, the timing — is made of these: the console holds real digests, paths and
 * durations, and the strip is the device this design uses to set a concrete value apart from the prose.
 */
export const ValueStrip = ({
  label,
  value,
  detail,
  valueClassName,
}: ValueStripProps) => (
  <div className="min-w-0">
    <MonoLabel>{label}</MonoLabel>
    <MonoChip className={cn("mt-1.5 text-[12px] text-ink", valueClassName)}>
      {value}
    </MonoChip>
    {detail && (
      <div className="mt-1 break-words text-[0.75rem] leading-[1.5] text-ink-mute">
        {detail}
      </div>
    )}
  </div>
);
