import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The small warm-grey uppercase caption above almost every value in the console. */
export const MutedLabel = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "text-[0.7rem] font-semibold uppercase tracking-[0.05em] text-ink-warm",
      className,
    )}
  >
    {children}
  </div>
);
