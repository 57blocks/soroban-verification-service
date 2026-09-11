import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionHeadProps = {
  label: string;
  title: ReactNode;
  description: ReactNode;
  /** `dark` recolours the three lines for the near-black sections. */
  tone?: "light" | "dark";
};

/** The eyebrow + display heading + blurb block that opens every landing section. */
export const SectionHead = ({
  label,
  title,
  description,
  tone = "light",
}: SectionHeadProps) => (
  <div className="mb-16 grid gap-1">
    <div>
      <span
        className={cn(
          "mb-3.5 block font-sans text-[0.9rem] font-medium",
          tone === "dark" ? "text-yellow" : "text-ink-soft",
        )}
      >
        {label}
      </span>
      <h2
        className={cn(
          "m-0 font-display text-[clamp(2rem,3.4vw,2.9rem)] font-medium leading-[1.12] tracking-[-0.01em]",
          tone === "dark" && "text-dark-bright",
        )}
      >
        {title}
      </h2>
    </div>
    <p
      className={cn(
        "mt-3 max-w-[62ch] font-sans text-base leading-[1.6]",
        tone === "dark" ? "text-dark-dim" : "text-ink-body",
      )}
    >
      {description}
    </p>
  </div>
);
