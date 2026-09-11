import { FadeUp } from "@/components/ui/fade-up";
import { securityCapabilities, securityHead } from "../content";
import { CapabilityGrid } from "./CapabilityGrid";
import { SectionHead } from "./SectionHead";

export const SecuritySection = () => (
  <section className="px-8 py-[120px]">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...securityHead} />
      </FadeUp>
    </div>
    <FadeUp>
      <CapabilityGrid items={securityCapabilities} />
    </FadeUp>
  </section>
);
