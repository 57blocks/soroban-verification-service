import { githubRepoUrl, sdkReadmeUrl, sourceIsPublic } from "@/config/site";
import type { SectionCopy } from "./types";

export const audienceHead: SectionCopy = {
  label: "Get started",
  title: "Two ways in.",
  description:
    "Developers verify a contract. Integrators read verified results without rebuilding anything — unauthenticated, no account.",
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
  /** The illustrative monospace strip on the card. A route that exists, never an invented one. */
  sample: string;
  action: AudienceAction;
};

/** A card as rendered. `action` is absent only where `visibleAudienceCards` withheld its destination. */
export type VisibleAudienceCard = Omit<AudienceCard, "action"> & {
  action?: AudienceAction;
};

/**
 * A third card addressed operators, and it is gone rather than corrected. It offered "one Compose file" as the
 * way to run your own verifier; the Compose file starts the services but not the rebuild path, which always
 * dispatches to AWS Batch (ADR-003). Self-hosting is real and documented — it is just not a landing-page
 * promise, so what remains of it is the pointer line in the footer.
 */
export const audienceCards: AudienceCard[] = [
  {
    label: "For developers",
    title: "Submit source. Get verified.",
    description:
      "Submit from the web console or straight to the REST API. Preflight reads the deployed Wasm first and prefills the manifest it can.",
    sample: "POST /api/verification/v1/verifications",
    action: { kind: "route", to: "/verify", label: "Start verification" },
  },
  {
    label: "For integrators",
    title: "Read verifier-attributed results.",
    description:
      "The TypeScript SDK takes the Trusted Verifiers List as data, queries every member in parallel, and returns one attributed entry each — including for the ones it could not reach.",
    sample: "GET /api/verification/v1/wasms/<hash>.json",
    action: { kind: "external", href: sdkReadmeUrl, label: "SDK reference" },
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
