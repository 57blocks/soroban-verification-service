import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { githubRepoUrl, sourceIsPublic } from "@/config/site";
import { Button } from "@/components/ui/button";
import { FadeUp } from "@/components/ui/fade-up";
import { closingCta, heroCopy } from "../content";

export const ClosingCta = () => (
  <section id="verify" className="bg-dark px-4 py-20 text-dark-bright md:px-20 md:py-24">
    <div className="mx-auto max-w-shell text-center">
      <FadeUp>
        <span className="block font-mono text-[11px] uppercase tracking-[0.12em] text-yellow">
          {closingCta.label}
        </span>
        <h2 className="m-0 mx-auto mt-4 max-w-[24ch] text-[26px] font-bold leading-tight tracking-tight text-dark-bright md:text-[32px]">
          {closingCta.title}
        </h2>
      </FadeUp>

      <FadeUp delay={150}>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3.5">
          <Button asChild variant="accent" size="lg">
            <Link to="/verify">
              {heroCopy.cta}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </Button>
          {sourceIsPublic && (
            <Button asChild variant="ghostDark" size="lg">
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
