import { FadeUp } from "@/components/ui/fade-up";
import { pipelineHead, pipelineStages } from "../content";
import { SectionHead } from "./SectionHead";

export const HowItWorksSection = () => (
  <section id="how" className="px-8 py-[120px]">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...pipelineHead} />
      </FadeUp>
    </div>

    <div className="mx-auto grid max-w-shell border border-line md:grid-cols-4">
      {pipelineStages.map(({ num, title, description }, index) => (
        // FadeUp is the grid item, so the divider and the row-filling height move onto it.
        <FadeUp
          key={num}
          delay={index * 100}
          className={[
            "h-full",
            index < pipelineStages.length - 1
              ? "md:border-r md:border-line"
              : "",
          ].join(" ")}
        >
          <div className="px-7 pb-12 pt-10">
            {/* The yellow highlight is an inset shadow so it hugs the digits, not the box. */}
            <span className="mb-[30px] block w-fit px-0.5 font-display text-[2.4rem] font-medium leading-none text-ink shadow-[inset_0_-0.28em_0_theme(colors.yellow.DEFAULT)]">
              {num}
            </span>
            <h3 className="m-0 mb-2.5 text-[1.25rem] font-semibold tracking-[-0.015em]">
              {title}
            </h3>
            <p className="m-0 text-[0.92rem] text-ink-body">{description}</p>
          </div>
        </FadeUp>
      ))}
    </div>
  </section>
);
