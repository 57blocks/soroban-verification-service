import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PillIconProps = {
  children: ReactNode;
  tone?: "yellow" | "ink";
  size?: "sm" | "md" | "lg";
  animated?: boolean;
  className?: string;
};

const sizeClass = {
  sm: "size-[26px] text-[0.85rem]",
  md: "size-7 text-[0.9rem]",
  lg: "size-8",
};

export const PillIcon = ({
  children,
  tone = "yellow",
  size = "lg",
  animated = false,
  className,
}: PillIconProps) => (
  <span
    data-pill-icon=""
    className={cn(
      "inline-grid shrink-0 place-items-center overflow-hidden rounded-full transition-colors",
      sizeClass[size],
      tone === "yellow" ? "bg-yellow text-ink" : "bg-ink text-yellow",
      className,
    )}
  >
    <span
      className={cn("inline-block", animated && "group-hover:animate-arrow-slide")}
    >
      {children}
    </span>
  </span>
);
