import { FadeUp } from "@/components/ui/fade-up";
import type { Capability } from "../content";
import { MonoChip } from "./MonoChip";
import { cn } from "@/lib/utils";

/**
 * The cards used by the result and security sections. `auto-fit` rather than a fixed column count: the two
 * sections carry six and four cards, and both read badly when the last row is a widow.
 *
 * A `wide` card takes the whole row and spends it on width rather than height — text left, sample right. It
 * opens the section, and it leaves the remaining five to fill the rows evenly behind it; two columns instead
 * of the row would leave the sixth card alone at the bottom.
 */
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
