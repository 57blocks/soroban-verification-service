import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";

/**
 * The two states a legal page gained when its text stopped being a build-time constant. A stated failure,
 * never an empty document (versioned-terms-and-assent design.md TA-6).
 */
const Shell = ({ title, children }: { title: string; children: ReactNode }) => (
  <main className="min-h-screen bg-surface font-sans leading-normal text-ink antialiased">
    <SiteNav />
    <article className="mx-auto max-w-console px-8 pb-16 pt-14">
      <h1 className="m-0 text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
        {title}
      </h1>
      {children}
      <SiteFooter />
    </article>
  </main>
);

export const LegalPageLoading = ({ title }: { title: string }) => (
  <Shell title={title}>
    <p data-testid="legal-loading" className="m-0 mt-6 text-[1.05rem] text-ink-mute">
      Loading…
    </p>
  </Shell>
);

export const LegalPageUnavailable = ({ title }: { title: string }) => (
  <Shell title={title}>
    <aside
      role="alert"
      data-testid="legal-unavailable"
      className="mt-6 rounded-lg border border-warning-line bg-warning-surface px-5 py-4"
    >
      <p className="m-0 font-sans text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-warning-fg">
        This document is unavailable
      </p>
      <p className="m-0 mt-2 text-[0.92rem] leading-[1.6] text-warning-ink">
        The operator&apos;s legal documents could not be loaded, so none are shown here rather than showing
        an empty page. Submissions are blocked while this is true. Try again shortly.
      </p>
    </aside>
  </Shell>
);
