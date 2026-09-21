import { FadeUp } from "@/components/ui/fade-up";
import { resultCards, resultHead } from "../content";
import { CardGrid } from "./CardGrid";
import { SectionHead } from "./SectionHead";

export const ResultSection = () => (
  <section
    id="result"
    className="border-y border-line bg-surface-alt px-4 py-16 md:px-20 md:py-24"
  >
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...resultHead} />
      </FadeUp>
      <CardGrid items={resultCards} />
    </div>
  </section>
);
