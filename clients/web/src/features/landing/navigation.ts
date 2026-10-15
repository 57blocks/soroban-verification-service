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
      { label: "Documentation", href: docsUrl },
      { label: "Security policy", href: securityPolicyUrl, external: true },
      { label: "GitHub", href: githubRepoUrl, external: true },
    ],
  },
];

export const operatorPointer = {
  prefix: "Running your own verifier?",
  label: "Self-hosted deployment guide",
  href: selfHostGuideUrl,
} as const;

export const visibleOperatorPointer = () =>
  sourceIsPublic ? operatorPointer : undefined;

export const visibleFooterColumns = () =>
  sourceIsPublic
    ? footerColumns
    : footerColumns
        .map((column) => ({
          ...column,
          items: column.items.filter((item) => !item.href.startsWith(githubRepoUrl)),
        }))
        .filter((column) => column.items.length > 0);
