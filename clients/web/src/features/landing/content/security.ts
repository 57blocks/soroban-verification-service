import type { Capability, SectionCopy } from "./types";

export const securityHead: SectionCopy = {
  label: "Security · Privacy",
  title: "Built to run untrusted source safely.",
  description:
    "Submitted Rust can execute code via build.rs, proc macros, and dependency scripts. The sandbox keeps that code away from the service. What it builds is part of the verified result, so review it with the source.",
};

export const securityCapabilities: Capability[] = [
  {
    title: "Sandbox isolation",
    description:
      "One-shot containers, no network, read-only root, non-root user, CPU / memory / PID caps.",
    sample: "--network none · --read-only · non-root",
  },
  {
    title: "Credential separation",
    description: "The rebuild container holds no database access and no keys.",
    sample: "db: none · keys: none",
  },
  {
    title: "Archive integrity",
    description:
      "Path, symlink and size checks; the archive is re-hashed before the build uses it.",
    sample: "sha256 re-checked before the build",
  },
  {
    title: "Private bytes deleted",
    description:
      "Non-public source, uploaded or fetched from your URL, is removed when the job ends, on every failure path too.",
    sample: "deleted on every terminal path",
  },
];
