import type { Capability, SectionCopy } from "./types";

export const resultHead: SectionCopy = {
  label: "What you get",
  title: "A result you can check, not a badge.",
  description:
    "Every verification publishes the same set of documents: the verdict, what produced it, and what it was produced from — each addressed by a hash, each attributed to the verifier that wrote it.",
};

export const resultCards: Capability[] = [
  {
    title: "A verdict, and what produced it",
    description:
      "The rebuilt Wasm is hashed outside the sandbox and compared with the deployed bytes. A match is byte for byte, or it is not a match.",
    wide: true,
    sample: [
      { text: "{\n  " },
      { text: '"result"', tone: "key" },
      { text: ": " },
      { text: '"verified"', tone: "verdict" },
      { text: ",\n  " },
      { text: '"deployed_wasm_hash"', tone: "key" },
      { text: ": " },
      { text: '"a91c…d8a3"', tone: "value" },
      { text: ",\n  " },
      { text: '"rebuilt_wasm_hash"', tone: "key" },
      { text: ": " },
      { text: '"a91c…d8a3"', tone: "value" },
      { text: ",\n  " },
      { text: '"verifier"', tone: "key" },
      { text: ": " },
      { text: '"example.org"', tone: "value" },
      { text: "\n}" },
    ],
  },
  {
    title: "Mismatch diagnostics",
    description:
      "Where the two differ: custom sections, imports, exports, and per-section size diffs — not a bare red cross.",
    sample: [
      { text: "≠", tone: "mismatch" },
      { text: " 2 custom sections · Δ +312 B" },
    ],
  },
  {
    title: "The recipe that rebuilt it",
    description:
      "The pinned build image, the CLI and Rust versions, and where the recipe came from — the contract's own metadata, or the submission.",
    sample: [
      { text: "build_recipe", tone: "key" },
      { text: " rustc 1.81.0 · digest-pinned image", tone: "value" },
    ],
  },
  {
    title: "Source, named by its hash",
    description:
      "Every report carries the source SHA-256, so what was verified stays on the record. Source declared public is served back by that hash while this verifier holds a copy.",
    sample: [
      { text: "source_sha256", tone: "key" },
      { text: " 4c1d…9e02 · is_public true", tone: "value" },
    ],
  },
  {
    title: "One verifier's answer, signed as such",
    description:
      "Documents are attributed. Nothing here claims to be the network's verdict — an aggregator reads several verifiers and shows you each one.",
    sample: [
      { text: "verifier", tone: "key" },
      { text: " example.org · policy default", tone: "value" },
    ],
  },
  {
    title: "An archived copy",
    description:
      "Report artifacts are archived to Arweave through Irys. HTTPS stays the primary read path; the archive is what outlives it.",
    sample: [
      { text: "arweave", tone: "key" },
      { text: " archive · https stays primary", tone: "value" },
    ],
  },
];
