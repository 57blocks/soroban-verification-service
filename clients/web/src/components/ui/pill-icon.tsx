import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PillIconProps = {
  children: ReactNode;
  /** Inverted for the yellow `accent` pill: black circle, yellow glyph. */
  tone?: "yellow" | "ink";
  size?: "sm" | "md" | "lg";
  /** Slides the glyph out right and back in from the left when the button is hovered. */
  animated?: boolean;
  className?: string;
};

const sizeClass = {
  sm: "size-[26px] text-[0.85rem]",
  md: "size-7 text-[0.9rem]",
  lg: "size-8",
};

/** The circular badge that terminates every pill button in the design. */
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
