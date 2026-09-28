import type { Capability, SectionCopy } from "./types";

export const securityHead: SectionCopy = {
  label: "Security · Privacy",
  title: "Built to run untrusted source safely.",
  description:
    "Submitted Rust can execute code via build.rs, proc macros, and dependency scripts. The service is designed for that reality.",
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
      "A non-public upload is removed when the job ends, on every failure path too.",
    sample: "deleted on every terminal path",
  },
];
