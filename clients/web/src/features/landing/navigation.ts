import {
  docsUrl,
  dockerReadmeUrl,
  githubRepoUrl,
  sdkReadmeUrl,
  securityPolicyUrl,
  sep58SpecUrl,
  sourceIsPublic,
} from "@/config/site";
import type { ContentLink } from "./content";

export const sectionLinks = [
  { href: "#how", label: "How it works" },
  { href: "#architecture", label: "Architecture" },
  { href: "#capabilities", label: "Capabilities" },
  { href: "#selfhost", label: "Self-host" },
];

/**
 * Every footer entry is a link now. A footer of dead ends reads as a shipped surface, so the placeholders are
 * gone and each column names what exists.
 */
export const footerColumns: { title: string; items: ContentLink[] }[] = [
  {
    title: "Product",
    items: [
      { label: "How it works", href: "#how" },
      { label: "Architecture", href: "#architecture" },
      { label: "Capabilities", href: "#capabilities" },
      { label: "TypeScript SDK", href: sdkReadmeUrl, external: true },
    ],
  },
  {
    title: "Operators",
    items: [
      { label: "Self-hosting", href: "#selfhost" },
      { label: "Compose files", href: dockerReadmeUrl, external: true },
      { label: "Security policy", href: securityPolicyUrl, external: true },
    ],
  },
  {
    title: "Resources",
    items: [
      { label: "SEP-58 reference", href: sep58SpecUrl, external: true },
      { label: "Documentation", href: docsUrl, external: true },
      { label: "GitHub", href: githubRepoUrl, external: true },
    ],
  },
];

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
