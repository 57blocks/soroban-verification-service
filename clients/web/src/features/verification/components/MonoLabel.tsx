import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The caption above a value. The landing page's eyebrow, at the same size and tracking: the console's previous
 * semibold sans micro-caps came from a type system this app no longer uses, and read as a second heading level
 * rather than as a label on evidence.
 *
 * `as` is for the few captions that really are a heading. Looking like an eyebrow does not stop a panel's
 * sub-heading being one, and dropping it out of the document outline is a regression a screen reader pays for.
 */
export const MonoLabel = ({
  children,
  className,
  as: Tag = "span",
}: {
  children: ReactNode;
  className?: string;
  as?: "span" | "h2" | "h3";
}) => (
  // A `span` by default, so a caption can also sit inline in a row; `block` is the default display and `cn`
  // lets a caller override it.
  <Tag
    className={cn(
      "m-0 block font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-ink-mute",
      className,
    )}
  >
    {children}
  </Tag>
);
