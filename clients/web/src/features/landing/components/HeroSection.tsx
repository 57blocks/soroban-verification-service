import { type ComponentType, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { FadeUp } from "@/components/ui/fade-up";
import type { LiquidEtherProps } from "@/components/ui/liquid-ether";
import { heroCopy } from "../content";
import { RebuildPipeline } from "./RebuildPipeline";

/**
 * The fluid's palette, slowest flow first.
 *
 * All three stops are pale yellows, and that is the point rather than a lack of nerve. `lightMode`
 * normalises every stop to its own chroma, so saturation is not something a stop can opt out of: the
 * accent itself comes back as (1, 0.83, 0.29), and once that covers a third of the hero behind a
 * headline it stops reading as the brand and starts reading as orange. What survives normalisation is
 * only the *hue*, so the ramp is picked by where it lands on the wheel — `#f2c134` renders at 34°, an
 * orange, and these three at 48° and up, a yellow.
 *
 * The accent is then still the accent. "Shared devices" in the README already reserves it for a verdict
 * or a highlight; an ambient wash that painted the hero the same gold would spend it.
 *
 * Module scope on purpose — the component rebuilds its renderer when the palette's *contents* change,
 * and an inline array would be a new value on every render.
 */
const heroFluidColors = ["#fffefb", "#fef8dc", "#fdf2c2"];

/**
 * The hero's fluid layer, fetched after mount.
 *
 * `three` is a large dependency for a decoration, and the landing page is the first thing anyone loads:
 * importing it statically put 137 kB of gzip in front of the headline — 58% onto a bundle that was
 * already the biggest thing on the page. So the module arrives late instead.
 *
 * Late means the import is the enhancement and never the page: if it is slow, the hero is simply its
 * previous self for a moment, and if it fails the hero stays that way, which is why the rejection is
 * swallowed rather than thrown at an error boundary this app does not otherwise need. The type import
 * above is deliberate — it is erased, so it does not pull the module back into this chunk.
 */
const HeroFluid = () => {
  const [LiquidEther, setLiquidEther] =
    useState<ComponentType<LiquidEtherProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("@/components/ui/liquid-ether")
      .then(({ LiquidEther: Loaded }) => {
        if (!cancelled) setLiquidEther(() => Loaded);
      })
      .catch(() => {
        /* A background that failed to load is a hero without a background. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!LiquidEther) return null;

  return (
    <LiquidEther
      colors={heroFluidColors}
      lightMode
      resolution={0.5}
      mouseForce={20}
      cursorSize={100}
      autoPointers={4}
      autoSpeed={0.22}
      autoIntensity={2.2}
      takeoverDuration={0.25}
      autoResumeDelay={200}
      autoRampDuration={1.2}
    />
  );
};

/**
 * The headline with its one marked word. The mark is a background gradient rather than a text colour: the
 * accent is unreadable as type on white, and behind ink it is exactly what it is for.
 */
const Headline = () => {
  const [before, after] = heroCopy.title.split(heroCopy.highlight);

  return (
    <h1 className="m-0 mx-auto max-w-[820px] text-4xl font-bold leading-[1.12] tracking-tight text-ink md:text-5xl lg:text-[54px]">
      {before}
      <span className="bg-gradient-to-b from-transparent from-64% to-yellow to-64%">
        {heroCopy.highlight}
      </span>
      {after}
    </h1>
  );
};

export const HeroSection = () => (
  <header
    id="hero"
    className="relative overflow-hidden border-b border-line-hero bg-gradient-to-b from-surface to-surface-hero px-4 md:px-20"
  >
    {/* The fluid, under everything and out of the way of every hit test: the component's canvas is
        `pointer-events-none` and it tracks the pointer from a window listener, so the CTA and the nav
        still take their own clicks. */}
    <div className="absolute inset-0" aria-hidden="true">
      <HeroFluid />
    </div>

    {/* The wash behind the diagram, sized to it rather than to the section, over the fluid. */}
    <div className="relative mx-auto max-w-shell bg-[radial-gradient(720px_340px_at_50%_78%,theme(colors.yellow.DEFAULT/0.30),transparent_70%)] pb-20 pt-20 text-center md:pb-[110px] md:pt-24">
      <FadeUp>
        <Headline />
      </FadeUp>

      <FadeUp delay={120}>
        <p className="m-0 mx-auto mt-5 max-w-[640px] text-lg leading-[1.6] text-ink-body">
          {heroCopy.lines.map((line, index) => (
            <span key={line}>
              {index > 0 && " "}
              {line}
            </span>
          ))}
        </p>
      </FadeUp>

      <FadeUp delay={240}>
        <div className="mt-8">
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
      </FadeUp>

      <FadeUp delay={360}>
        <RebuildPipeline />
      </FadeUp>
    </div>
  </header>
);
