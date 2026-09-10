import { FadeUp } from "@/components/ui/fade-up";
import { architectureHead, architectureLayers } from "../content";
import { SectionHead } from "./SectionHead";

export const ArchitectureSection = () => (
  <section id="architecture" className="bg-dark px-8 py-[120px] text-dark-fg">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead tone="dark" {...architectureHead} />
      </FadeUp>
    </div>

    <div className="mx-auto grid max-w-shell gap-6 md:grid-cols-3">
      {architectureLayers.map(({ num, title, items }, layerIndex) => (
        // `h-full` on both: FadeUp is the grid item now, so the card only fills the row if the wrapper
        // stretches and the card follows it.
        <FadeUp key={num} delay={layerIndex * 120} className="h-full">
          <div className="h-full border border-dark-line bg-dark-card px-8 pb-12 pt-10">
            <span className="mb-7 block font-mono text-[0.75rem] tracking-[0.15em] text-yellow">
              {num}
            </span>
            <h3 className="m-0 mb-6 font-display text-[1.65rem] font-medium tracking-[-0.01em]">
              {title}
            </h3>
            <ul className="m-0 list-none p-0">
              {items.map((item, index) => (
                <li
                  key={item}
                  className={[
                    "text-[0.92rem] text-dark-text",
                    index === 0 ? "pt-3" : "border-t border-dark-rule pt-3",
                    index === 1 ? "mt-3" : "",
                    index > 0 && index < items.length - 1 ? "pb-3" : "",
                  ].join(" ")}
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </FadeUp>
      ))}
    </div>
  </section>
);
