import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const MonoLabel = ({
  children,
  className,
  as: Tag = "span",
}: {
  children: ReactNode;
  className?: string;
  as?: "span" | "h2" | "h3";
}) => (
  <Tag
    className={cn(
      "m-0 block font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-ink-mute",
      className,
    )}
  >
    {children}
  </Tag>
);
