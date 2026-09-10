import type { Capability, SectionCopy } from "./types";

export const platformHead: SectionCopy = {
  label: "Capabilities",
  title: "End to end.",
  description:
    "Everything from reading a deployed contract's own metadata to publishing an attributed, archived result — handled by the service.",
};

/**
 * Two cards left and two arrived. "Retroactive" described the outcome; "Composed environments" is the mechanism
 * that produces it, and naming the mechanism is what makes the claim checkable.
 */
export const platformCapabilities: Capability[] = [
  {
    title: "Metadata-driven",
    description: "SEP-58 fields read from the deployed Wasm, never from the submitter.",
    icon: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  },
  {
    title: "Composed environments",
    description:
      "No build image on chain? The recorded CLI and Rust versions compose a pinned one.",
    icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  },
  {
    title: "Private source",
    description: "Uploaded archive, pinned by SHA-256. The bytes are never published.",
    icon: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  },
  {
    title: "Published source",
    description: "Source declared public is kept and served back by its SHA-256.",
    icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15h6",
  },
  {
    title: "Mismatch diagnostics",
    description: "Custom sections, imports, exports, and per-section size diffs.",
    icon: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  {
    title: "Separate trust signals",
    description: "Recipe source, build isolation, SEP-55 marker, source visibility.",
    icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  {
    title: "Decentralized archive",
    description: "Report artifacts archived to Arweave through Irys. HTTPS stays primary.",
    icon: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
  },
  {
    title: "Network-aware",
    description: "Mainnet and testnet. A contract address is re-resolved on every query.",
    icon: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20M12 2c3 3 3 17 0 20c-3-3-3-17 0-20",
  },
  {
    title: "Open source",
    description: "Apache-2.0 licensed. Compose file, OpenAPI spec, query SDK.",
    icon: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9",
  },
];

export const securityHead: SectionCopy = {
  label: "Security · Privacy",
  title: "Built to run untrusted source safely.",
  description:
    "Submitted Rust can execute code via build.rs, proc macros, and dependency scripts. The service is designed for that reality.",
};

/**
 * Two claims here were wrong rather than merely vague. The sandbox card advertised seccomp and AppArmor
 * profiles, which `services/builder` configures nowhere.
 */
export const securityCapabilities: Capability[] = [
  {
    title: "Sandbox isolation",
    description:
      "One-shot containers, no network, read-only root, non-root user, CPU / memory / PID caps.",
    icon: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12",
  },
  {
    title: "Credential separation",
    description: "The rebuild container holds no database access and no keys.",
    icon: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m3 3L22 7l-3-3",
  },
  {
    title: "Archive integrity",
    description:
      "Path, symlink and size checks; the archive is re-hashed before the build uses it.",
    icon: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  },
  {
    title: "Private bytes deleted",
    description:
      "A non-public upload is removed when the job ends, on every failure path too.",
    icon: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  },
  {
    title: "No KYC",
    description: "Unauthenticated public queries. Submitters are counted by a hashed IP.",
    icon: "M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M18 8l5 5M23 8l-5 5",
  },
  {
    title: "Abuse controls",
    description: "Per-route sliding windows over that fingerprint, plus recipe-level dedup.",
    icon: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  },
];
