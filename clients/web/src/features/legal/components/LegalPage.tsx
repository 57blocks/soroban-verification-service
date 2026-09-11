import { legalLinks } from "@/config/site";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { draftBannerCopy, openItemsHeading } from "../content/shared";
import type { LegalBundle, LegalDocument } from "@/lib/legal";
import { renderInline } from "../utils/render-inline";
import { LegalBlocks } from "./LegalBlocks";

const statusLine = (effectiveDate: string | null) =>
  effectiveDate === null ? "Draft, pending legal review" : `In effect from ${effectiveDate}`;

/** Yellow because a draft is a warning to the reader, not an error. */
const DraftBanner = () => (
  <aside
    role="note"
    data-testid="legal-draft-banner"
    className="mb-10 rounded-lg border border-warning-line bg-warning-surface px-5 py-4"
  >
    <p className="m-0 font-sans text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-warning-fg">
      {draftBannerCopy.title}
    </p>
    <p className="m-0 mt-2 text-[0.92rem] leading-[1.6] text-warning-ink">
      {draftBannerCopy.body}
    </p>
  </aside>
);

const OpenItems = ({ items }: { items: string[] }) => (
  <section
    id="open-items"
    data-testid="legal-open-items"
    className="mt-14 rounded-lg border border-line-strong bg-surface-alt p-6"
  >
    <h2 className="m-0 font-mono text-[0.72rem] font-medium uppercase tracking-[0.18em] text-ink-mute">
      {openItemsHeading}
    </h2>
    <ol className="m-0 mt-4 grid list-decimal gap-3 pl-6">
      {items.map((item, index) => (
        <li key={index} className="m-0 text-[0.92rem] leading-[1.6] text-ink-body">
          {renderInline(item)}
        </li>
      ))}
    </ol>
  </section>
);

/** The other documents, so a reader who arrived at one can find the rest. */
const SeeAlso = ({ current }: { current: LegalDocument["slug"] }) => {
  const others = legalLinks.filter(({ to }) => to !== `/${current}`);
  if (others.length === 0) return null;
  return (
    <p className="mt-12 text-[0.92rem] text-ink-mute">
      {renderInline(`See also: ${others.map(({ to, label }) => `[${label}](${to})`).join(" · ")}`)}
    </p>
  );
};

/**
 * `bundle` supplies everything that used to be a build-time constant: the operator's name, whether the text
 * is a draft, and where its revision history lives.
 */
export const LegalPage = ({ doc, bundle }: { doc: LegalDocument; bundle: LegalBundle }) => {
  const isDraft = bundle.effectiveDate === null;
  return (
  <main className="min-h-screen bg-surface font-sans leading-normal text-ink antialiased">
    <SiteNav />
    <article className="mx-auto max-w-console px-8 pb-16 pt-14">
      <header className="mb-8">
        <span className="mb-3.5 block font-sans text-[0.9rem] font-medium text-ink-soft">
          Legal · {bundle.operatorName} reference deployment
        </span>
        <h1 className="m-0 font-display text-[clamp(2rem,3.4vw,2.9rem)] font-medium leading-[1.12] tracking-[-0.01em]">
          {doc.title}
        </h1>
        <p className="m-0 mt-3 font-mono text-[0.75rem] uppercase tracking-[0.12em] text-ink-mute">
          {statusLine(bundle.effectiveDate)}
          {bundle.historyUrl !== null && (
            <>
              {" · "}
              <a
                href={bundle.historyUrl}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-line-quiet hover:text-ink"
              >
                Revision history
              </a>
            </>
          )}
          {" · "}
          <span data-testid="legal-version">Version {bundle.version}</span>
        </p>
      </header>

      {isDraft && <DraftBanner />}

      <p className="m-0 mb-10 text-[1.05rem] leading-[1.7] text-ink-body">
        {renderInline(doc.intro)}
      </p>

      <nav aria-label="Contents" className="mb-12 rounded-lg bg-surface-alt p-5">
        <ol className="m-0 grid list-none gap-1.5 p-0 text-[0.9rem]">
          {doc.sections.map(({ id, heading }) => (
            <li key={id}>
              <a href={`#${id}`} className="text-ink-body hover:text-ink hover:underline">
                {heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="grid gap-12">
        {doc.sections.map(({ id, heading, blocks }) => (
          <section key={id} id={id} className="scroll-mt-24">
            <h2 className="m-0 mb-4 font-display text-[1.45rem] font-medium leading-[1.25]">
              {heading}
            </h2>
            <LegalBlocks blocks={blocks} />
          </section>
        ))}
      </div>

      {isDraft && doc.openItems.length > 0 && <OpenItems items={doc.openItems} />}

      <SeeAlso current={doc.slug} />

      <SiteFooter />
    </article>
  </main>
  );
};
