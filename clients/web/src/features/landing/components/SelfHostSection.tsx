import { FadeUp } from "@/components/ui/fade-up";
import { selfHostHead, selfHostModes } from "../content";
import { SectionHead } from "./SectionHead";

export const SelfHostSection = () => (
  <section id="selfhost" className="bg-surface-alt px-8 py-[120px]">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...selfHostHead} />
      </FadeUp>

      <div className="grid gap-6 md:grid-cols-2">
        {selfHostModes.map(({ title, description, command }, index) => (
          // `h-full` on both keeps the cards row-height as they were before FadeUp took over as the grid item.
          <FadeUp key={title} delay={index * 120} className="h-full">
            <div className="h-full rounded-2xl border border-line bg-surface px-7 py-9">
              <h3 className="m-0 mb-3.5 font-display text-[1.5rem] font-medium tracking-[-0.01em]">
                {title}
              </h3>
              <p className="m-0 mb-6 text-[0.95rem] text-ink-body">
                {description}
              </p>
              <div className="rounded-lg bg-ink px-4 py-3 font-mono text-[0.82rem] text-dark-cmd">
                <span className="text-yellow">$ </span>
                {command}
              </div>
            </div>
          </FadeUp>
        ))}
      </div>
    </div>
  </section>
);
