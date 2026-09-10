import { brandName } from "../content";

/** The wordmark shown in both the landing nav and the footer. */
export const BrandLogo = () => (
  <a
    href="#hero"
    className="flex items-center gap-3 text-[0.95rem] font-semibold text-ink"
    aria-label="Back to hero"
  >
    <img src="/logo.svg" alt="" className="block size-7 shrink-0" />
    <span>{brandName}</span>
  </a>
);
