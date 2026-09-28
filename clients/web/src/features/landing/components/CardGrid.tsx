import { MonoChip } from "@/components/mono-chip";
import { FadeUp } from "@/components/ui/fade-up";
import type { Capability } from "../content";
import { cn } from "@/lib/utils";

export const CardGrid = ({ items }: { items: Capability[] }) => (
  <div className="mx-auto grid max-w-shell gap-6 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
    {items.map(({ title, description, sample, wide }, index) => (
      <FadeUp
        key={title}
        delay={index * 80}
        className={cn("h-full", wide && "md:col-span-full")}
      >
        <div
          className={cn(
            "h-full rounded-xl border border-line bg-surface p-6 transition-all duration-150 hover:-translate-y-1 hover:shadow-lg",
            wide ? "grid gap-6 md:grid-cols-[1fr_auto] md:items-center" : "flex flex-col gap-2",
          )}
        >
          <div className={cn(wide && "flex flex-col gap-2")}>
            <h3 className="m-0 text-base font-semibold text-ink">{title}</h3>
            <p className="m-0 max-w-[62ch] text-sm leading-[1.55] text-ink-body">{description}</p>
          </div>
          {sample && <MonoChip sample={sample} className={cn(!wide && "mt-2")} />}
        </div>
      </FadeUp>
    ))}
  </div>
);
