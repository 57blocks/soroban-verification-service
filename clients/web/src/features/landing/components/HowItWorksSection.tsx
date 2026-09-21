import { FadeUp } from "@/components/ui/fade-up";
import { pipelineHead, pipelineStages } from "../content";
import { MonoChip } from "./MonoChip";
import { SectionHead } from "./SectionHead";

export const HowItWorksSection = () => (
  <section id="how" className="bg-surface px-4 py-16 md:px-20 md:py-24">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...pipelineHead} />
      </FadeUp>

      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        {pipelineStages.map(({ num, title, description, sample }, index) => (
          <FadeUp key={num} delay={index * 80} className="h-full">
            <div className="flex h-full flex-col gap-2 rounded-xl border border-line bg-surface p-6 transition-all duration-150 hover:-translate-y-1 hover:shadow-lg">
              <span className="font-mono text-[13px] font-medium text-yellow-deep">{num}</span>
              <h3 className="m-0 text-base font-semibold text-ink">{title}</h3>
              <p className="m-0 mb-2 text-sm leading-[1.55] text-ink-body">{description}</p>
              <MonoChip sample={sample} />
            </div>
          </FadeUp>
        ))}
      </div>
    </div>
  </section>
);
