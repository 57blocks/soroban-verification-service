import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { FadeUp } from "@/components/ui/fade-up";
import { Typewriter } from "@/components/ui/typewriter";
import { HeroFlow } from "@/components/ui/hero-flow";
import { heroCopy } from "../content";
import { RebuildPipeline } from "./RebuildPipeline";

const heroFlowColors: [string, string, string] = ["#fdf6dd", "#fbecb4", "#f7dc7a"];

const renderTitle = (displayed: string) => {
  const start = heroCopy.title.indexOf(heroCopy.highlight);
  const end = start + heroCopy.highlight.length;
  const highlighted = displayed.slice(start, end);

  return (
    <>
      {displayed.slice(0, start)}
      {highlighted && (
        <span className="animate-gradient-pan bg-hero-spectrum bg-[length:200%_auto] bg-clip-text text-transparent motion-reduce:animate-none">
          {highlighted}
        </span>
      )}
      {displayed.slice(end)}
    </>
  );
};

const headlineCursor = "_";

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const HeroBackground = () => {
  const [animate] = useState(() => !prefersReducedMotion());
  return animate ? <HeroFlow colors={heroFlowColors} /> : null;
};

const Headline = () => {
  const [animate] = useState(() => !prefersReducedMotion());

  return (
    <h1 className="m-0 mx-auto max-w-[13.6em] text-4xl font-bold leading-[1.12] tracking-tight text-ink md:text-5xl lg:text-[54px]">
      {animate ? (
        <>
          <span className="sr-only">{heroCopy.title}</span>
          <span aria-hidden="true" className="grid">
            <span className="invisible col-start-1 row-start-1 whitespace-pre-wrap">
              {renderTitle(heroCopy.title)}
              <span className="ml-1 inline-block">{headlineCursor}</span>
            </span>
            <Typewriter
              as="span"
              className="col-start-1 row-start-1"
              text={heroCopy.title}
              typeMs={60}
              eraseMs={60}
              startDelayMs={800}
              cursor={headlineCursor}
              cursorClassName="font-light text-ink-body"
              renderText={renderTitle}
            />
          </span>
        </>
      ) : (
        renderTitle(heroCopy.title)
      )}
    </h1>
  );
};

export const HeroSection = () => (
  <header
    id="hero"
    className="relative overflow-hidden border-b border-line-hero bg-gradient-to-b from-surface to-surface-hero px-4 md:px-20"
  >
    <div className="absolute inset-0" aria-hidden="true">
      <HeroBackground />
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
