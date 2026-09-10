import { dockerReadmeUrl, githubRepoUrl, sdkReadmeUrl, sourceIsPublic } from "@/config/site";
import type { SectionCopy } from "./types";

export const audienceHead: SectionCopy = {
  label: "Get started",
  title: "Built for three audiences.",
  description:
    "Developers verify a contract. Integrators read results without rebuilding. Operators self-host an independent verifier.",
};

/**
 * Where a card sends you. `route` is a path in this app's own route tree, so `to` is the literal TanStack
 * Router type-checks against; `external` leaves the app.
 */
export type AudienceAction =
  | { kind: "route"; to: "/verify"; label: string }
  | { kind: "external"; href: string; label: string };

export type AudienceCard = {
  label: string;
  title: string;
  description: string;
  action: AudienceAction;
};

/** A card as rendered. `action` is absent only where `visibleAudienceCards` withheld its destination. */
export type VisibleAudienceCard = Omit<AudienceCard, "action"> & {
  action?: AudienceAction;
};

export const audienceCards: AudienceCard[] = [
  {
    label: "For developers",
    title: "Submit source. Get verified.",
    description:
      "Submit from the web console or straight to the REST API. Preflight reads the deployed Wasm first and prefills the manifest it can.",
    action: { kind: "route", to: "/verify", label: "Start verification" },
  },
  {
    label: "For integrators",
    title: "Read verifier-attributed results.",
    description:
      "The TypeScript SDK takes the Trusted Verifiers List as data, queries every member in parallel, and returns one attributed entry each — including for the ones it could not reach.",
    action: { kind: "external", href: sdkReadmeUrl, label: "SDK reference" },
  },
  {
    label: "For operators",
    title: "Run your own verifier.",
    description:
      "One Compose file brings up the API, orchestrator, query service and console, publishing under your own verifier identity.",
    action: { kind: "external", href: dockerReadmeUrl, label: "Operator guide" },
  },
];

/**
 * The cards as rendered. A card whose only destination is the private repository keeps its copy and loses its
 * call to action — the copy describes what exists, the link would 404.
 */
export const visibleAudienceCards = (): VisibleAudienceCard[] =>
  sourceIsPublic
    ? audienceCards
    : audienceCards.map((card) =>
        card.action.kind === "external" && card.action.href.startsWith(githubRepoUrl)
          ? { ...card, action: undefined }
          : card,
      );
