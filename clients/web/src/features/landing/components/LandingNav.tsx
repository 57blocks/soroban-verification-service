import { Link } from "@tanstack/react-router";
import { heroCopy } from "../content";
import { sectionLinks } from "../navigation";
import { BrandLogo } from "./BrandLogo";

/** Sticky, translucent, and blurred — it sits over the hero's dot field. */
export const LandingNav = () => (
  <nav className="sticky top-0 z-50 border-b border-line bg-surface/[0.92] backdrop-blur-[10px]">
    <div className="mx-auto flex max-w-shell flex-wrap items-center justify-between gap-4 px-8 py-[18px]">
      <BrandLogo />

      <div className="hidden gap-8 text-[0.9rem] md:flex">
        {sectionLinks.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            className="border-b-2 border-transparent pb-0.5 text-ink-body transition-colors hover:border-yellow hover:text-ink"
          >
            {label}
          </a>
        ))}
      </div>

      <Link
        to="/verify"
        className="inline-flex items-center gap-1.5 border-b-2 border-transparent pb-0.5 text-[0.875rem] font-semibold text-ink transition-colors hover:border-yellow"
      >
        {heroCopy.cta} →
      </Link>
    </div>
  </nav>
);
