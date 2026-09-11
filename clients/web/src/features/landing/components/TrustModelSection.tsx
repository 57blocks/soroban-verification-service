import { Badge } from "@/components/ui/badge";
import { FadeUp } from "@/components/ui/fade-up";
import { trustModelHead, trustSignals } from "../content";
import { SectionHead } from "./SectionHead";

export const TrustModelSection = () => (
  <section className="px-8 py-[120px]">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...trustModelHead} />
      </FadeUp>

      <div className="grid gap-6 md:grid-cols-2">
        {trustSignals.map(({ tone, glyph, title, description, tag }, index) => (
          // `h-full` on both keeps the cards row-height as they were before FadeUp took over as the grid item.
          <FadeUp key={title} delay={index * 120} className="h-full">
            <div className="grid h-full justify-items-start gap-5 border border-line bg-surface p-8 transition-colors hover:bg-surface-hover">
              <span
                aria-hidden
                className={[
                  "grid size-11 place-items-center rounded-full text-[18px] font-semibold",
                  tone === "ok"
                    ? "bg-success-wash text-success-fg"
                    : "bg-danger-wash text-danger-fg",
                ].join(" ")}
              >
                {glyph}
              </span>
              <span className="text-[1.15rem] font-semibold">{title}</span>
              <p className="m-0 text-[0.92rem] leading-[1.55] text-ink-body">
                {description}
              </p>
              <Badge variant="chip" size="tag">
                {tag}
              </Badge>
            </div>
          </FadeUp>
        ))}
      </div>
    </div>
  </section>
);
