import { Link } from "@tanstack/react-router";
import { legalLinks } from "@/config/site";
import { cn } from "@/lib/utils";

/** Terms · Privacy, wherever a footer needs them. */

type LegalLinksProps = {
  className?: string;
  /** Open each document in a new tab instead of navigating this one. */
  newTab?: boolean;
};

export const LegalLinks = ({ className, newTab = false }: LegalLinksProps) => (
  <span className={cn("inline-flex flex-wrap items-center gap-x-2", className)}>
    {legalLinks.map(({ to, label }, index) => (
      <span key={to} className="inline-flex items-center gap-x-2">
        {index > 0 && <span aria-hidden>·</span>}
        <Link
          to={to}
          // `@tanstack/react-router`'s `Link` only intercepts the click when the target is absent or `_self`
          // (link.js's `handleClick`), so this really does hand the navigation to the browser rather than
          // routing in place.
          {...(newTab
            ? {
                target: "_blank" as const,
                rel: "noopener noreferrer",
                "aria-label": `${label} (opens in a new tab)`,
              }
            : {})}
          className="transition-colors hover:text-ink hover:underline hover:decoration-yellow hover:decoration-2"
        >
          {label}
        </Link>
      </span>
    ))}
  </span>
);
