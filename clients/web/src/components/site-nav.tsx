import { Link } from "@tanstack/react-router";
import { PageLinkAnchor } from "@/components/page-link";
import { githubRepoUrl, sourceIsPublic } from "@/config/site";
import { pageLinks, verifyLink } from "@/config/navigation";

export const SiteNav = () => (
  <nav className="sticky top-0 z-50 border-b border-line bg-surface/[0.92] backdrop-blur-[10px]">
    <div className="mx-auto flex max-w-shell items-center justify-between gap-6 px-4 py-[18px] sm:px-8">
      <Link
        to="/"
        className="flex items-center gap-3 text-[0.95rem] font-semibold text-ink"
        aria-label="Soroban Verifier home"
      >
        <img src="/logo.svg" alt="" className="block size-7 shrink-0" />
        <span className="hidden sm:inline">Soroban Verifier</span>
      </Link>

      <div className="flex items-center gap-5 sm:gap-6">
        {[verifyLink, ...pageLinks()].map((link) => (
          <PageLinkAnchor
            key={link.label}
            link={link}
            className="border-y-2 border-transparent py-0.5 text-[0.875rem] font-semibold text-ink-body transition-colors hover:border-b-yellow hover:text-ink focus-visible:border-b-yellow focus-visible:text-ink focus-visible:outline-none data-[status=active]:border-b-yellow data-[status=active]:text-ink"
          >
            {link.label}
          </PageLinkAnchor>
        ))}
        {sourceIsPublic && (
          <a
            href={githubRepoUrl}
            target="_blank"
            rel="noreferrer"
            title="View source on GitHub"
            aria-label="View source on GitHub"
            className="inline-grid size-9 place-items-center rounded-md border border-line-strong bg-surface text-[0.8rem] font-bold text-ink transition-colors hover:border-ink hover:bg-surface-alt"
          >
            GH
          </a>
        )}
      </div>
    </div>
  </nav>
);
