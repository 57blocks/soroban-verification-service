import { ArchitectureSection } from "./ArchitectureSection";
import { AudienceSection } from "./AudienceSection";
import { CapabilitiesSection } from "./CapabilitiesSection";
import { ClosingCta } from "./ClosingCta";
import { HeroSection } from "./HeroSection";
import { HowItWorksSection } from "./HowItWorksSection";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import { SecuritySection } from "./SecuritySection";
import { SelfHostSection } from "./SelfHostSection";
import { TrustModelSection } from "./TrustModelSection";
import { TrustStrip } from "./TrustStrip";

/** Section order is the narrative order; the nav anchors depend on it. */
export const LandingPage = () => (
  <main className="min-h-screen bg-surface font-sans leading-normal text-ink antialiased">
    <LandingNav />
    <HeroSection />
    <TrustStrip />
    <AudienceSection />
    <HowItWorksSection />
    <ArchitectureSection />
    <TrustModelSection />
    <CapabilitiesSection />
    <SecuritySection />
    <SelfHostSection />
    <ClosingCta />
    <LandingFooter />
  </main>
);
