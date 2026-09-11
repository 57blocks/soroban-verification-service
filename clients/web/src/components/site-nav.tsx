import { Link } from "@tanstack/react-router";
import { githubRepoUrl, sourceIsPublic } from "@/config/site";

/**
 * The compact nav shared by every page that is not the landing page: the wordmark home, and — once the source
 * is public — the round GitHub link on the right.
 */
export const SiteNav = () => (
  <nav className="sticky top-0 z-50 border-b border-line-strong bg-surface/[0.92] backdrop-blur-[10px]">
    <div className="mx-auto flex max-w-shell items-center justify-between gap-6 px-8 py-[18px]">
      <Link
        to="/"
        className="flex items-center gap-3 text-[0.95rem] font-semibold text-ink"
      >
        <img src="/logo.svg" alt="" className="block size-7 shrink-0" />
        <span>Soroban Verifier</span>
      </Link>

      {sourceIsPublic && (
        <a
          href={githubRepoUrl}
          target="_blank"
          rel="noreferrer"
          title="View source on GitHub"
          aria-label="View source on GitHub"
          className="inline-grid size-9 place-items-center rounded-full border border-line-strong bg-surface text-[0.8rem] font-bold text-ink transition-colors hover:border-ink hover:bg-yellow"
        >
          GH
        </a>
      )}
    </div>
  </nav>
);
