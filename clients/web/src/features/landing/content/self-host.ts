import type { SectionCopy } from "./types";

/** Three modes were listed. What ships is one Compose file, and the subset of it you start. */
export const selfHostHead: SectionCopy = {
  label: "Self-host",
  title: "Run the part you need.",
  description:
    "One committed Compose file, started whole or in part. Rebuilds always dispatch to AWS Batch — there is no local build path, by decision. Apache-2.0 licensed.",
};

export type SelfHostMode = {
  title: string;
  description: string;
  command: string;
};

export const selfHostModes: SelfHostMode[] = [
  {
    title: "Full stack",
    description:
      "Verification API, orchestrator, query service and console on one host, from committed configuration.",
    command: "docker compose -f docker/docker-compose.full-stack.yml up",
  },
  {
    title: "Verifier-only",
    description:
      "The same file without the query service, for an operator who publishes results but aggregates nobody else's.",
    command: "docker compose … up verification-svc orchestrator-svc web",
  },
];
