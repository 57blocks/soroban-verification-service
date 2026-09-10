import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { DotFieldLight } from "@/components/ui/dot-field";
import RotatingText from "@/components/ui/rotating-text";
import { FadeUp } from "@/components/ui/fade-up";
import { heroCopy, rotatingWords } from "../content";

export const HeroSection = () => (
  <section
    id="hero"
    className="relative overflow-hidden border-b border-line-hero bg-surface-hero px-8 pb-[116px] pt-[100px]"
  >
    <DotFieldLight />

    <div className="relative z-[2] mx-auto grid max-w-shell justify-items-center gap-10 text-center">
      <h1 className="m-0 font-display text-[clamp(2.25rem,5.4vw,4.8rem)] font-medium leading-[1.12] tracking-[-0.01em] text-ink md:whitespace-nowrap">
        {/* One FadeUp per line, each a block — the line's own inline flow stays intact.
            Wrapping only part of a line in an inline-block sizes that box to the widest
            line and opens a gap where the rest of the line should continue, which is
            what the `<br/>`-inside-one-wrapper version did. */}
        <FadeUp as="span" display="block" delay={0}>
          Where Soroban source
        </FadeUp>
        <FadeUp as="span" display="block" delay={120}>
          meets{" "}
          <span className="font-display font-medium italic shadow-[inset_0_-0.18em_0_theme(colors.yellow.DEFAULT)]">
            <RotatingText
              words={rotatingWords}
              intervalMs={2800}
              staggerMs={45}
            />
          </span>{" "}
          trust.
        </FadeUp>
      </h1>

      <FadeUp delay={300}>
        <div className="grid justify-items-center gap-8">
          <p className="m-0 font-sans text-[1.05rem] leading-[1.6] text-ink-body">
            {heroCopy.lines.map((line, index) => (
              <span key={line}>
                {index > 0 && <br />}
                <span className="md:whitespace-nowrap">{line}</span>
              </span>
            ))}
          </p>

          <div className="flex flex-wrap gap-3.5">
            <Button
              asChild
              variant="primary"
              size="pillHero"
              className="border-0 hover:bg-ink-hover"
            >
              <Link to="/verify">
                {heroCopy.cta}
                <PillIcon size="md" animated>
                  →
                </PillIcon>
              </Link>
            </Button>
          </div>
        </div>
      </FadeUp>
    </div>
  </section>
);
