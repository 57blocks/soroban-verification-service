import { AudienceSection } from "./AudienceSection";
import { ClosingCta } from "./ClosingCta";
import { HeroSection } from "./HeroSection";
import { HowItWorksSection } from "./HowItWorksSection";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import { ResultSection } from "./ResultSection";
import { SecuritySection } from "./SecuritySection";
import { TrustModelSection } from "./TrustModelSection";
import { TrustStrip } from "./TrustStrip";

/** Section order is the narrative order; the nav anchors depend on it. */
export const LandingPage = () => (
  <main className="min-h-screen bg-surface font-sans leading-normal text-ink antialiased">
    <LandingNav />
    <HeroSection />
    <TrustStrip />
    <HowItWorksSection />
    <ResultSection />
    <TrustModelSection />
    <SecuritySection />
    <AudienceSection />
    <ClosingCta />
    <LandingFooter />
  </main>
);
