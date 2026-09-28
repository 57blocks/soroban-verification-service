import { githubRepoUrl, sdkReadmeUrl, sourceIsPublic } from "@/config/site";
import type { SectionCopy } from "./types";

export const audienceHead: SectionCopy = {
  label: "Get started",
  title: "Two ways in.",
  description:
    "Developers verify a contract. Integrators read verified results without rebuilding anything — unauthenticated, no account.",
};

export type AudienceAction =
  | { kind: "route"; to: "/verify"; label: string }
  | { kind: "external"; href: string; label: string };

export type AudienceCard = {
  label: string;
  title: string;
  description: string;
  sample: string;
  action: AudienceAction;
};

export type VisibleAudienceCard = Omit<AudienceCard, "action"> & {
  action?: AudienceAction;
};

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

export const visibleAudienceCards = (): VisibleAudienceCard[] =>
  sourceIsPublic
    ? audienceCards
    : audienceCards.map((card) =>
        card.action.kind === "external" && card.action.href.startsWith(githubRepoUrl)
          ? { ...card, action: undefined }
          : card,
      );
