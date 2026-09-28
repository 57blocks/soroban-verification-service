import { companyUrl } from "@/config/site";
import { LegalLinks } from "./legal-links";

type SiteFooterProps = {
  legalLinksInNewTab?: boolean;
};

export const SiteFooter = ({ legalLinksInNewTab = false }: SiteFooterProps = {}) => (
  <footer className="mx-auto mt-14 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[0.85rem] text-ink-mute">
    <span className="inline-flex items-center gap-2">
      © 2026
      <a
        href={companyUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center"
      >
        <img src="/57blocks.png" alt="57Blocks" className="block h-[15px] w-auto" />
      </a>
    </span>
    <LegalLinks newTab={legalLinksInNewTab} />
  </footer>
);
