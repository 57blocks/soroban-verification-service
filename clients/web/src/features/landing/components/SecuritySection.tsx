import { FadeUp } from "@/components/ui/fade-up";
import { securityCapabilities, securityHead } from "../content";
import { CardGrid } from "./CardGrid";
import { SectionHead } from "./SectionHead";

export const SecuritySection = () => (
  <section
    id="security"
    className="border-y border-line bg-surface-alt px-4 py-16 md:px-20 md:py-24"
  >
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...securityHead} />
      </FadeUp>
      <CardGrid items={securityCapabilities} />
    </div>
  </section>
);
