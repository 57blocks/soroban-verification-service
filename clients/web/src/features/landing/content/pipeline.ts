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
};

export const pipelineStages: PipelineStage[] = [
  {
    num: "01",
    title: "Preflight",
    description:
      "Read the deployed Wasm's SEP-58 fields and answer with a prefilled manifest — or with the reason this contract cannot be verified.",
  },
  {
    num: "02",
    title: "Submit",
    description:
      "A public archive URL, or a private upload. Either way the bytes are pinned by SHA-256 before anything runs.",
  },
  {
    // Was "Sandboxed Stellar CLI inside a digest-pinned trusted image".
    num: "03",
    title: "Rebuild",
    description:
      "Rebuild in the digest-pinned image on AWS Batch, with no network. The hash comparison runs outside the sandbox.",
  },
  {
    num: "04",
    title: "Publish",
    description:
      "Per-hash status objects and a content-addressed report over HTTPS, plus an Arweave copy. Attributed to this verifier.",
  },
];
