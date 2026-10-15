import { isAggregatorEnabled } from "./features";
import { docsUrl } from "./site";

type LinkCopy = { label: string; description: string };

export type PageLink = LinkCopy & ({ to: "/verify" | "/query" } | { href: string });

export const verifyLink: PageLink = {
  to: "/verify",
  label: "Verify",
  description: "Submit a deployed contract and its source",
};

/** A function, not a constant: the lookup's flag is read at runtime, after the bundle is built. */
export const pageLinks = (): PageLink[] => [
  ...(isAggregatorEnabled()
    ? [
        {
          to: "/query" as const,
          label: "Lookup",
          description: "Every verifier's result for a contract or Wasm hash",
        },
      ]
    : []),
  { href: docsUrl, label: "Docs", description: "Guides, quick starts and the API reference" },
];
