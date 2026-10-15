import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { PageLinkAnchor } from "@/components/page-link";
import { pageLinks } from "@/config/navigation";
import { heroCopy } from "../content";
import { BrandLogo } from "./BrandLogo";

/** Equal transparent borders above and below keep the text on the CTA's centre line. */
const underline =
  "border-y-2 border-transparent py-0.5 transition-colors hover:border-b-yellow hover:text-ink focus-visible:outline-none focus-visible:border-b-yellow focus-visible:text-ink";

export const LandingNav = () => (
  <nav className="sticky top-0 z-50 border-b border-line bg-surface/[0.92] px-4 py-4 backdrop-blur-[10px] md:px-20">
    <div className="mx-auto flex max-w-shell items-center justify-between gap-4">
      <BrandLogo />

      <div className="flex items-center gap-5 whitespace-nowrap sm:gap-6">
        {pageLinks().map((link) => (
          <PageLinkAnchor
            key={link.label}
            link={link}
            className={`${underline} text-[0.875rem] font-semibold text-ink-body`}
          >
            {link.label}
          </PageLinkAnchor>
        ))}
        <span aria-hidden="true" className="hidden h-4 w-px bg-line-strong sm:block" />
        <Link
          to="/verify"
          className="hidden items-center gap-1.5 text-[0.875rem] font-semibold text-ink transition-colors hover:text-ink-body sm:inline-flex"
        >
          {heroCopy.cta}
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  </nav>
);
