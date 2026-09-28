import { type ComponentType, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { FadeUp } from "@/components/ui/fade-up";
import type { LiquidEtherProps } from "@/components/ui/liquid-ether";
import { heroCopy } from "../content";
import { RebuildPipeline } from "./RebuildPipeline";

const heroFluidColors = ["#fffefb", "#fef8dc", "#fdf2c2"];

const HeroFluid = () => {
  const [LiquidEther, setLiquidEther] =
    useState<ComponentType<LiquidEtherProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("@/components/ui/liquid-ether")
      .then(({ LiquidEther: Loaded }) => {
        if (!cancelled) setLiquidEther(() => Loaded);
      })
      .catch(() => {});
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
    <div className="absolute inset-0" aria-hidden="true">
      <HeroFluid />
    </div>

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
