import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeUp } from "@/components/ui/fade-up";
import { heroCopy } from "../content";
import { RebuildPipeline } from "./RebuildPipeline";

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
    className="border-b border-line-hero bg-gradient-to-b from-surface to-surface-hero px-4 md:px-20"
  >
    {/* The wash behind the diagram, sized to it rather than to the section. */}
    <div className="mx-auto max-w-shell bg-[radial-gradient(720px_340px_at_50%_78%,theme(colors.yellow.DEFAULT/0.30),transparent_70%)] pb-20 pt-20 text-center md:pb-[110px] md:pt-24">
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
          <Button asChild variant="primary" size="lg">
            <Link to="/verify">
              {heroCopy.cta}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
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
