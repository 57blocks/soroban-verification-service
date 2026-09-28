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
    className="relative overflow-hidden bg-dark px-4 py-20 text-dark-bright md:px-20 md:py-[140px]"
  >
    <DotFieldDark />

    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_400px_at_80%_50%,theme(colors.yellow.DEFAULT/0.16),transparent_70%)]"
    />

    <div className="relative mx-auto grid max-w-shell items-end gap-10 md:grid-cols-[1fr_auto]">
      <FadeUp>
        <span className="block font-mono text-[11px] uppercase tracking-[0.12em] text-yellow">
          {closingCta.label}
        </span>
        <h2 className="m-0 mt-4 max-w-[24ch] text-[30px] font-bold leading-tight tracking-tight text-dark-bright md:text-[38px]">
          {closingCta.title}
        </h2>
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
