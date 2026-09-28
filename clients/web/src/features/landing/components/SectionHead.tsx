import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionHeadProps = {
  label: string;
  title: ReactNode;
  description: ReactNode;
  tone?: "light" | "dark";
};

export const SectionHead = ({
  label,
  title,
  description,
  tone = "light",
}: SectionHeadProps) => (
  <div className="mb-9">
    <div
      className={cn(
        "mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em]",
        tone === "dark" ? "text-yellow" : "text-yellow-deep",
      )}
    >
      {label}
    </div>
    <h2
      className={cn(
        "m-0 text-[26px] font-bold leading-tight tracking-tight md:text-[32px]",
        tone === "dark" && "text-dark-bright",
      )}
    >
      {title}
    </h2>
    <p
      className={cn(
        "m-0 mt-2 max-w-[62ch] text-base leading-[1.6]",
        tone === "dark" ? "text-dark-dim" : "text-ink-body",
      )}
    >
      {description}
    </p>
  </div>
);
