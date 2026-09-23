import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

/**
 * What an unrouted path renders, whether it arrived by client-side navigation or as a fresh document — the
 * origin serves this page with a 404 status rather than the shell with a 200.
 */
export const NotFoundPage = () => (
  <main className="min-h-screen bg-surface font-sans leading-normal text-ink antialiased">
    <SiteNav />
    <article className="mx-auto max-w-console px-8 pb-16 pt-14" data-testid="not-found">
      <header className="mb-8">
        <span className="mb-3.5 block font-mono text-[0.75rem] uppercase tracking-[0.12em] text-ink-mute">
          404
        </span>
        <h1 className="m-0 text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
          No page at this address
        </h1>
      </header>

      <p className="m-0 mb-10 text-[1.05rem] leading-[1.7] text-ink-body">
        The link may be out of date. Verification results are addressed by job, so a job link that no
        longer resolves means the job id is wrong rather than that the result was withdrawn — published
        reports are permanent.
      </p>

      <Button asChild>
        <Link to="/verify">
          Go to the console
          <PillIcon animated>→</PillIcon>
        </Link>
      </Button>

      <SiteFooter />
    </article>
  </main>
);
