import { LegalLinks } from "@/components/legal-links";
import { companyUrl } from "@/config/site";
import { FadeUp } from "@/components/ui/fade-up";
import { footerBlurb, footerLegal } from "../content";
import { visibleFooterColumns, visibleOperatorPointer } from "../navigation";
import { BrandLogo } from "./BrandLogo";

/**
 * Light, where the design had it near-black with the closing CTA. The footer carries the company mark, and a
 * dark band leaves only two ways to show it: invert it to a white silhouette, which discards the mark's own
 * colours, or let it sit unreadable. The near-black band stops at the CTA instead.
 */
export const LandingFooter = () => {
  const operator = visibleOperatorPointer();

  return (
    <footer className="border-t border-line bg-surface-alt px-4 pb-10 pt-14 md:px-20">
      <div className="mx-auto grid max-w-shell gap-10 border-b border-line pb-10 md:grid-cols-[2fr_1fr_1fr]">
        <FadeUp>
          <div>
            <BrandLogo />
            <p className="m-0 mt-4 max-w-[32ch] text-[0.9rem] leading-6 text-ink-body">
              {footerBlurb}
            </p>
          </div>
        </FadeUp>

        {visibleFooterColumns().map(({ title, items }, colIdx) => (
          <FadeUp key={title} delay={colIdx * 100}>
            <h4 className="m-0 mb-4 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-mute">
              {title}
            </h4>
            <ul className="m-0 grid list-none gap-2.5 p-0">
              {items.map(({ label, href, external }) => (
                <li key={label}>
                  <a
                    href={href}
                    className="text-[0.875rem] text-ink-body transition-colors hover:text-ink"
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

      {/* All that is left of the self-host section — and it renders only where the guide it names can be
          opened, because a pointer into a repository a reader cannot reach is worse than no pointer. */}
      {operator && (
        <p className="mx-auto mt-7 max-w-shell text-[0.8rem] text-ink-mute">
          {operator.prefix}{" "}
          <a
            href={operator.href}
            target="_blank"
            rel="noreferrer"
            className="text-ink-body underline decoration-yellow decoration-2 underline-offset-2 transition-colors hover:text-ink"
          >
            {operator.label}
          </a>
        </p>
      )}

      <div className="mx-auto mt-7 flex max-w-shell flex-wrap justify-between gap-3 text-[0.8rem] text-ink-mute">
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
            <img src="/57blocks.png" alt="57Blocks" className="block h-[15px] w-auto" />
          </a>
        </span>
      </div>
    </footer>
  );
};
