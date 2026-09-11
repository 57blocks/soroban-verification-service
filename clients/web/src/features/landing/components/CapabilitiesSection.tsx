import { FadeUp } from "@/components/ui/fade-up";
import { platformCapabilities, platformHead } from "../content";
import { CapabilityGrid } from "./CapabilityGrid";
import { SectionHead } from "./SectionHead";

export const CapabilitiesSection = () => (
  <section id="capabilities" className="bg-surface-alt px-8 py-[120px]">
    <div className="mx-auto max-w-shell">
      <FadeUp>
        <SectionHead {...platformHead} />
      </FadeUp>
    </div>
    <FadeUp>
      <CapabilityGrid items={platformCapabilities} />
    </FadeUp>
  </section>
);
