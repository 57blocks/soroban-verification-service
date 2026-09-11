import type { Capability } from "../content";

/** The nine/six icon cards used by both the capabilities and the security sections. */
export const CapabilityGrid = ({ items }: { items: Capability[] }) => (
  <div className="mx-auto grid max-w-shell gap-6 md:grid-cols-3">
    {items.map(({ title, description, icon }) => (
      <div
        key={title}
        className="border border-line bg-surface px-7 py-8 transition-colors hover:bg-surface-hover"
      >
        <svg
          aria-hidden
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mb-[18px] block text-ink"
        >
          <path d={icon} />
        </svg>
        <h3 className="m-0 mb-2.5 text-[1.15rem] font-semibold tracking-[-0.01em]">
          {title}
        </h3>
        <p className="m-0 text-[0.92rem] text-ink-body">{description}</p>
      </div>
    ))}
  </div>
);
