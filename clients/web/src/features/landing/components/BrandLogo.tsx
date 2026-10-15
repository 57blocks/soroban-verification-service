import { brandName } from "../content";

export const BrandLogo = () => (
  <a
    className="flex items-center gap-3 text-[0.95rem] font-semibold text-ink"
    aria-label="Back to hero"
  >
    <img src="/logo.svg" alt="" className="block size-7 shrink-0" />
    <span className="whitespace-nowrap">{brandName}</span>
  </a>
);
