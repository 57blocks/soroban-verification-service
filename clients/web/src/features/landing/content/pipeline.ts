import type { SectionCopy } from "./types";

/** The heading said "Four stages. Under 15 minutes. */
export const pipelineHead: SectionCopy = {
  label: "How it works",
  title: "Four stages, one pipeline.",
  description:
    "Two flows share it: metadata-driven for contracts carrying SEP-58 fields, submitted-evidence for legacy or private code.",
};

export type PipelineStage = {
  num: string;
  title: string;
  description: string;
  /** The illustrative monospace strip along the card's bottom. */
  sample: string;
};

export const pipelineStages: PipelineStage[] = [
  {
    num: "01",
    title: "Preflight",
    description:
      "Read the deployed Wasm's SEP-58 fields and answer with a prefilled manifest — or with the reason this contract cannot be verified.",
    sample: "sep-58 · rustc + sdk read from the chain",
  },
  {
    num: "02",
    title: "Submit",
    description:
      "A public archive URL, or a private upload. Either way the bytes are pinned by SHA-256 before anything runs.",
    sample: "CDLZ…K5WQ ← archive sha256 91f3…c0d4",
  },
  {
    // Was "Sandboxed Stellar CLI inside a digest-pinned trusted image".
    num: "03",
    title: "Rebuild",
    description:
      "Rebuild in the digest-pinned image on AWS Batch, with no network. The hash comparison runs outside the sandbox.",
    sample: "sandbox · no network · aws batch",
  },
  {
    num: "04",
    title: "Publish",
    description:
      "Per-hash status objects and a content-addressed report over HTTPS, plus an Arweave copy. Attributed to this verifier.",
    sample: "reports/<sha256>.json · attributed",
  },
];

/**
 * The hero diagram's labels. Every value is illustrative — nothing here is fetched — but each names something
 * the service really does: a source archive pinned by its hash, a sandbox with no network and no credentials,
 * a hash comparison performed outside that sandbox, and an attributed published result.
 */
export const pipelineSample = {
  sourceLabel: "source",
  source: "acme/token @ 91f3c0d",
  seal: "sealed · no network · no credentials",
  rebuild: "rebuild → rebuilt.wasm",
  rebuiltHash: "sha256 a91c…d8a3",
  chainLabel: "stellar ledger",
  contract: "contract CDLZ…K5WQ",
  deployed: "deployed.wasm — bytes as deployed",
  deployedHash: "sha256 a91c…d8a3",
  // `verified` is the status the service actually publishes (docs/glossary.md), not a synonym.
  verdict: "verified",
  verdictNote: "compared outside the sandbox",
  published: "published · attributed",
} as const;
