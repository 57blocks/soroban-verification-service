import type { ReactNode } from "react";
import { MonoChip } from "@/components/mono-chip";
import { cn } from "@/lib/utils";
import { MonoLabel } from "./MonoLabel";

type ValueStripProps = {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  valueClassName?: string;
  className?: string;
};

export const ValueStrip = ({
  label,
  value,
  detail,
  valueClassName,
  className,
}: ValueStripProps) => (
  <div className={cn("min-w-0", className)}>
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
