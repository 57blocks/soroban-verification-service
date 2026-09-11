import { Link } from "@tanstack/react-router";
import { githubRepoUrl, sourceIsPublic } from "@/config/site";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { DotFieldDark } from "@/components/ui/dot-field";
import { FadeUp } from "@/components/ui/fade-up";
import { closingCta, heroCopy } from "../content";

export const ClosingCta = () => (
  <section
    id="verify"
    className="relative overflow-hidden bg-dark px-8 py-[140px] text-dark-bright"
  >
    <DotFieldDark />
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-cta-glow"
    />

    <div className="relative mx-auto grid max-w-shell items-end gap-12 md:grid-cols-[1fr_auto]">
      <FadeUp delay={0}>
        <div>
          <span className="block font-sans text-[0.9rem] font-medium text-yellow">
            {closingCta.label}
          </span>
          <h2 className="m-0 mt-4 max-w-[24ch] font-display text-[clamp(2rem,3.4vw,2.9rem)] font-medium leading-[1.12] tracking-[-0.01em] text-dark-bright">
            {closingCta.title}
          </h2>
        </div>
      </FadeUp>

      <FadeUp delay={150}>
        <div className="flex flex-wrap items-center gap-3.5">
          <Button asChild variant="accent" size="pillHero" className="border-0">
            <Link to="/verify">
              {heroCopy.cta}
              <PillIcon tone="ink" size="md" animated>
                →
              </PillIcon>
            </Link>
          </Button>
          {sourceIsPublic && (
            <Button asChild variant="ghostDark" size="pillHeroFlat">
              <a href={githubRepoUrl} target="_blank" rel="noreferrer">
                {closingCta.secondaryCta}
              </a>
            </Button>
          )}
        </div>
      </FadeUp>
    </div>
  </section>
);
