import {
  docsUrl,
  githubRepoUrl,
  sdkReadmeUrl,
  securityPolicyUrl,
  selfHostGuideUrl,
  sep58SpecUrl,
  sourceIsPublic,
} from "@/config/site";
import type { ContentLink } from "./content";

export const sectionLinks = [
  { href: "#how", label: "How it works" },
  { href: "#result", label: "What you get" },
  { href: "#trust", label: "Trust model" },
  { href: "#security", label: "Security" },
];

/**
 * Two columns, where there were three. The `Operators` column is gone with the section it pointed into —
 * everything an operator needs is documentation, and it is reached from `operatorPointer` below rather than
 * from a column of links that made self-hosting look like a product surface.
 */
export const footerColumns: { title: string; items: ContentLink[] }[] = [
  {
    title: "Product",
    items: [
      { label: "How it works", href: "#how" },
      { label: "What you get", href: "#result" },
      { label: "Trust model", href: "#trust" },
      { label: "TypeScript SDK", href: sdkReadmeUrl, external: true },
    ],
  },
  {
    title: "Resources",
    items: [
      { label: "SEP-58 reference", href: sep58SpecUrl, external: true },
      { label: "Documentation", href: docsUrl, external: true },
      { label: "Security policy", href: securityPolicyUrl, external: true },
      { label: "GitHub", href: githubRepoUrl, external: true },
    ],
  },
];

/**
 * All that is left of the self-host section: one line, above the footer's legal row. Running a verifier needs
 * infrastructure this page cannot hand anyone (ADR-003 dispatches every rebuild to AWS Batch), so the honest
 * surface is a link to the guide that says so.
 */
export const operatorPointer = {
  prefix: "Running your own verifier?",
  label: "Self-hosted deployment guide",
  href: selfHostGuideUrl,
} as const;

/** Withheld with every other link into a repository nobody outside the organisation can open. */
export const visibleOperatorPointer = () =>
  sourceIsPublic ? operatorPointer : undefined;

/**
 * What the footer actually renders. `footerColumns` stays the full set — it is what the link gate in
 * `landing-content.spec.ts` checks — and a column that loses every item is dropped rather than left as a
 * heading over nothing.
 */
export const visibleFooterColumns = () =>
  sourceIsPublic
    ? footerColumns
    : footerColumns
        .map((column) => ({
          ...column,
          items: column.items.filter((item) => !item.href.startsWith(githubRepoUrl)),
        }))
        .filter((column) => column.items.length > 0);
