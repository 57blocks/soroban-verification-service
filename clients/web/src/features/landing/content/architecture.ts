import type { SectionCopy } from "./types";

export const architectureHead: SectionCopy = {
  label: "Architecture",
  title: "Three independent layers.",
  description:
    "Verification, publishing and query are separate deployables. One Compose file runs all three on a host, or you run only the half you operate.",
};

export type ArchitectureLayer = {
  num: string;
  title: string;
  items: string[];
};

/** The checker only reads the instructing documents, which is why this copy kept the retired name. */
export const architectureLayers: ArchitectureLayer[] = [
  {
    num: "— LAYER 01",
    title: "Hosted Verifier",
    items: [
      "Verification API · preflight, submit, status",
      // The deployed unit is orchestrator-svc; the design's "Worker" is the same thing.
      "Orchestrator · state machine, dispatch",
      "Sandboxed rebuild on AWS Batch",
      "Byte-for-byte match, outside the sandbox",
    ],
  },
  {
    num: "— LAYER 02",
    title: "Result Publishing",
    items: [
      "Per-hash status objects",
      "Content-addressed report artifacts",
      "Public source, served by SHA-256",
      "Arweave archive via Irys",
    ],
  },
  {
    num: "— LAYER 03",
    title: "Public Query",
    items: [
      "Public Query API · free, no KYC",
      "TypeScript SDK · browser or Node",
      "Trusted Verifiers List",
      "Cursor-paged bulk load, CORS-enabled",
    ],
  },
];
