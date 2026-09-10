import { Link } from "@tanstack/react-router";
import { FadeUp } from "@/components/ui/fade-up";
import { audienceHead, visibleAudienceCards } from "../content";
import { SectionHead } from "./SectionHead";

/** Both arms of `AudienceAction` render the same underlined call to action. */
const actionClass =
  "inline-flex items-center gap-1.5 border-b-2 border-yellow pb-0.5 text-[0.9rem] font-semibold transition-colors hover:border-ink";

export const AudienceSection = () => {
  const cards = visibleAudienceCards();

  return (
    <section className="px-8 pt-[120px]">
      <div className="mx-auto max-w-shell">
        <FadeUp>
          <SectionHead {...audienceHead} />
        </FadeUp>
      </div>

      {/* One hairline grid: each card carries the divider on its right, the last one does not. */}
      <div className="mx-auto grid max-w-shell border border-line md:grid-cols-3">
        {cards.map(({ label, title, description, action }, index) => (
          // FadeUp is the grid item, so it carries the divider and `h-full` — without that the card's background
          // stops short of the tallest cell in the row.
          <FadeUp
            key={label}
            delay={index * 120}
            className={[
              "h-full",
              index < cards.length - 1 ? "md:border-r md:border-line" : "",
            ].join(" ")}
          >
            <div className="h-full bg-surface px-8 pb-14 pt-12 transition-colors hover:bg-surface-hover">
              <span className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-yellow-deep">
                {label}
              </span>
              <h3 className="mb-4 mt-[18px] font-display text-[1.9rem] font-medium leading-[1.12] tracking-[-0.01em]">
                {title}
              </h3>
              <p className="m-0 mb-7 text-[0.95rem] text-ink-body">
                {description}
              </p>

              {!action ? null : action.kind === "route" ? (
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
          </FadeUp>
        ))}
      </div>
    </section>
  );
};
