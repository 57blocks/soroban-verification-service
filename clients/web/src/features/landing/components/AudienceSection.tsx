import { Link } from "@tanstack/react-router";
import { MonoChip } from "@/components/mono-chip";
import { FadeUp } from "@/components/ui/fade-up";
import { audienceHead, visibleAudienceCards } from "../content";
import { SectionHead } from "./SectionHead";

/** Both arms of `AudienceAction` render the same underlined call to action. */
const actionClass =
  "inline-flex items-center gap-1.5 border-b-2 border-yellow pb-0.5 text-[0.9rem] font-semibold transition-colors hover:border-ink";

export const AudienceSection = () => {
  const cards = visibleAudienceCards();

  return (
    <section id="start" className="bg-surface px-4 py-16 md:px-20 md:py-24">
      <div className="mx-auto max-w-shell">
        <FadeUp>
          <SectionHead {...audienceHead} />
        </FadeUp>

        <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
          {cards.map(({ label, title, description, sample, action }, index) => (
            // FadeUp is the grid item, so it carries `h-full` — without that the card's background stops short
            // of the tallest cell in the row.
            <FadeUp key={label} delay={index * 120} className="h-full">
              <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-6 transition-all duration-150 hover:-translate-y-1 hover:shadow-lg md:p-7">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-yellow-deep">
                  {label}
                </span>
                <h3 className="mb-2 mt-3 text-lg font-semibold leading-tight text-ink">{title}</h3>
                <p className="m-0 mb-5 text-sm leading-[1.6] text-ink-body">{description}</p>

                <MonoChip sample={sample} className="mt-auto" />

                {action && (
                  <div className="mt-5">
                    {action.kind === "route" ? (
                      <Link to={action.to} className={actionClass}>
                        {action.label} →
                      </Link>
                    ) : (
                      <a
                        href={action.href}
                        target="_blank"
                        rel="noreferrer"
                        className={actionClass}
                      >
                        {action.label} →
                      </a>
                    )}
                  </div>
                )}
              </div>
            </FadeUp>
          ))}
        </div>
      </div>
    </section>
  );
};
