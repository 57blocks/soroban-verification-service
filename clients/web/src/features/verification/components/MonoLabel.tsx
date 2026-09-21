import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The caption above a value. The landing page's eyebrow, at the same size and tracking: the console's previous
 * semibold sans micro-caps came from a type system this app no longer uses, and read as a second heading level
 * rather than as a label on evidence.
 */
export const MonoLabel = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  // A `span` rather than a `div`, so a caption can also sit inline in a row; `block` is the default and
  // `cn` lets a caller override it.
  <span
    className={cn(
      "block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute",
      className,
    )}
  >
    {children}
  </span>
);
