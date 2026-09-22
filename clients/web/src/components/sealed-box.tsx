import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The sandbox, drawn as the one box with a heavier edge and a label on its rim. The motif means "this happened
 * inside the sealed environment": the landing page's diagram uses it for the rebuild lane, and the console uses
 * it for the inputs a real rebuild ran on.
 */
export const SealedBox = ({
  label,
  className,
  children,
}: {
  /** The chip on the rim — what the seal is. */
  label: string;
  className?: string;
  children: ReactNode;
}) => (
  <div
    className={cn(
      "relative rounded-xl border-[1.5px] border-ink bg-surface px-5 pb-4 pt-[22px] text-left",
      className,
    )}
  >
    <span className="absolute -top-[11px] left-4 rounded-md bg-ink px-2.5 py-[3px] font-mono text-[10px] text-white">
      {label}
    </span>
    {children}
  </div>
);
