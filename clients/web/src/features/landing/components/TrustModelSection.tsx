import { Badge } from "@/components/ui/badge";
import { FadeUp } from "@/components/ui/fade-up";
import { trustModelHead, trustSignals } from "../content";
import { HashCompare } from "./HashCompare";
import { SectionHead } from "./SectionHead";

export const TrustModelSection = () => (
  <section id="trust" className="bg-surface px-4 py-16 md:px-20 md:py-24">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...trustModelHead} />
      </FadeUp>

      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
        {trustSignals.map(({ tone, title, description, tag, compare }, index) => (
          <FadeUp key={title} delay={index * 120} className="h-full">
            <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-6 transition-all duration-150 hover:-translate-y-1 hover:shadow-lg md:p-7">
              <div className="mb-5 flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 rounded-full ${tone === "ok" ? "bg-success-fg" : "bg-danger-fg"}`}
                />
                <span
                  className={`font-mono text-xs font-medium ${tone === "ok" ? "text-success-fg" : "text-danger-fg"}`}
                >
                  {title}
                </span>
              </div>

              <span className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
                deployed
              </span>
              <HashCompare compare={compare} />
              <span className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
                rebuilt
              </span>

              <p className="m-0 mt-5 text-sm leading-[1.6] text-ink-body">{description}</p>
              <div className="mt-4">
                <Badge variant="chip" size="tag">
                  {tag}
                </Badge>
              </div>
            </div>
          </FadeUp>
        ))}
      </div>
    </div>
  </section>
);
