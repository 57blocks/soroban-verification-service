import { LegalLinks } from "@/components/legal-links";
import { companyUrl } from "@/config/site";
import { FadeUp } from "@/components/ui/fade-up";
import { footerBlurb, footerLegal } from "../content";
import { visibleFooterColumns } from "../navigation";
import { BrandLogo } from "./BrandLogo";

export const LandingFooter = () => (
  <footer className="border-t border-line bg-surface px-8 pb-12 pt-20">
    <div className="mx-auto grid max-w-shell gap-14 border-b border-line pb-14 md:grid-cols-[2fr_1fr_1fr_1fr]">
      <FadeUp>
        <div>
          <BrandLogo />
          <p className="m-0 mt-5 max-w-[32ch] font-display text-[0.95rem] text-ink-body">
            {footerBlurb}
          </p>
        </div>
      </FadeUp>

      {visibleFooterColumns().map(({ title, items }, colIdx) => (
        <FadeUp key={title} delay={colIdx * 100}>
          <h4 className="m-0 mb-5 font-mono text-[0.7rem] font-medium uppercase tracking-[0.18em] text-ink-mute">
            {title}
          </h4>
          <ul className="m-0 grid list-none gap-3 p-0">
            {items.map(({ label, href, external }) => (
              <li key={label}>
                <a
                  href={href}
                  className="text-[0.92rem] text-ink-body transition-colors hover:text-ink hover:underline hover:decoration-yellow hover:decoration-2"
                  {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </FadeUp>
      ))}
    </div>

    <div className="mx-auto mt-8 flex max-w-shell flex-wrap justify-between gap-3 text-[0.85rem] text-ink-mute">
      <span className="inline-flex flex-wrap items-center gap-x-2">
        <span>{footerLegal}</span>
        <span aria-hidden>·</span>
        <LegalLinks />
      </span>
      <span className="inline-flex items-center gap-2">
        © 2026
        <a
          href={companyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center"
        >
          <img
            src="/57blocks.png"
            alt="57Blocks"
            className="block h-[15px] w-auto"
          />
        </a>
      </span>
    </div>
  </footer>
);
