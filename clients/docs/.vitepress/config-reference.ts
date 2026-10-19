import { fileURLToPath } from "node:url";
import { loadManifest } from "../../../eng-tools/env-manifest.mjs";
import { CONFIG_SUMMARIES } from "./config-summaries.ts";

type Entry = {
  type?: string;
  values?: string[];
  required?: boolean | "forbidden" | null;
  required_when?: string | null;
  fail?: "boot" | "first-use" | "silent" | "n/a";
  default?: unknown;
  secret?: boolean;
  deploy?: string;
};
type Block = Record<string, Entry | null> | undefined;
type Service = {
  inherits?: string[];
  variables?: Block;
  tunables?: Block;
  build_variables?: Block;
};

const GROUPS: Record<string, { title: string; about: string }> = {
  base: { title: "Every service", about: "Server settings common to the long-running services." },
  postgres: { title: "The verifier's database", about: "The verifier's PostgreSQL database." },
  "query-postgres": {
    title: "The aggregator's database",
    about: "The aggregator's own PostgreSQL database, separate from the verifier's.",
  },
  "result-storage": {
    title: "Result storage",
    about: "Where published results are written and the public URL they are read from.",
  },
  "verifier-identity": { title: "Verifier identity", about: "Who this verifier says it is in everything it publishes." },
  "verifier-policy": { title: "Verifier policy", about: "What the published `policy.json` declares." },
  "stellar-cli": { title: "Stellar CLI", about: "The services that call the `stellar` command." },
};

const SERVICES: Record<string, { title: string; about: string }> = {
  "verification-svc": { title: "verification-svc", about: "The Submission API." },
  "orchestrator-svc": {
    title: "orchestrator-svc",
    about: "Runs jobs: resolves source, dispatches builds, compares and publishes. Not exposed publicly.",
  },
  "query-svc": { title: "query-svc", about: "The aggregator and its Query API." },
  web: { title: "web", about: "The console and this documentation. These values are fixed when the image is built." },
  builder: { title: "builder", about: "Runs each rebuild in its sandbox, as a batch job." },
  composer: { title: "composer", about: "Composes build environments for contracts without a recorded image, as a batch job." },
  "db-migrate": { title: "db-migrate", about: "Applies database migrations before a deployment." },
};

const PROSE_DEFAULT = /^(falls back to|per service|the )/;

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n+/g, " ");

const listed = (block: Block): [string, Entry][] =>
  Object.entries(block ?? {})
    .map(([name, entry]): [string, Entry] => [name, entry ?? {}])
    .filter(([, entry]) => entry.required !== "forbidden" && entry.deploy !== "never");

const required = (entry: Entry): string => {
  if (entry.required_when) return `When \`${entry.required_when}\``;
  if (entry.required !== true) return "No";
  if (entry.fail === "first-use") return "Yes, checked on first use";
  if (entry.fail === "silent") return "Yes, not checked";
  return "Yes";
};

const defaultOf = (entry: Entry): string => {
  const value = entry.default;
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string" && PROSE_DEFAULT.test(value)) return cell(value);
  return `\`${cell(String(value))}\``;
};

const describe = (name: string, entry: Entry): string => {
  const parts = [CONFIG_SUMMARIES[name]];
  if (entry.values?.length) parts.push(`One of ${entry.values.map((v) => `\`${v}\``).join(", ")}.`);
  if (entry.secret) parts.push("A secret.");
  return cell(parts.join(" "));
};

const table = (entries: [string, Entry][]): string[] => [
  "| Variable | Required | Default | What it does |",
  "| --- | --- | --- | --- |",
  ...entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => `| \`${name}\` | ${required(entry)} | ${defaultOf(entry)} | ${describe(name, entry)} |`),
];

/** Markdown, so every variable name is in the page text that search indexes. */
export const configReferenceMarkdown = (): string => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const manifest = loadManifest(root) as {
    groups: Record<string, { variables?: Block }>;
    services: Record<string, Service>;
  };

  const names = new Set<string>();
  for (const group of Object.values(manifest.groups)) for (const [n] of listed(group.variables)) names.add(n);
  for (const service of Object.values(manifest.services))
    for (const block of [service.variables, service.tunables, service.build_variables])
      for (const [n] of listed(block)) names.add(n);

  const undocumented = [...names].filter((n) => !(n in CONFIG_SUMMARIES));
  const stale = Object.keys(CONFIG_SUMMARIES).filter((n) => !names.has(n));
  const unknownGroups = Object.keys(manifest.groups).filter((g) => !(g in GROUPS));
  const unknownServices = Object.keys(manifest.services).filter((s) => !(s in SERVICES));
  if (undocumented.length || stale.length || unknownGroups.length || unknownServices.length) {
    throw new Error(
      "clients/docs/.vitepress/config-summaries.ts or config-reference.ts is out of step with config/env-manifest.yaml — " +
        `undescribed variables: ${undocumented.join(", ") || "none"}; no longer declared: ${stale.join(", ") || "none"}; ` +
        `untitled groups: ${unknownGroups.join(", ") || "none"}; untitled services: ${unknownServices.join(", ") || "none"}`,
    );
  }

  const sections: string[] = ["## Shared settings", ""];
  for (const [key, group] of Object.entries(manifest.groups)) {
    const entries = listed(group.variables);
    if (!entries.length) continue;
    const readers = Object.entries(manifest.services)
      .filter(([, service]) => service.inherits?.includes(key))
      .map(([name]) => `\`${name}\``);
    sections.push(
      `### ${GROUPS[key].title}`,
      "",
      `${GROUPS[key].about} Read by ${readers.join(", ")}.`,
      "",
      ...table(entries),
      "",
    );
  }

  sections.push("## Each service", "");
  for (const [key, service] of Object.entries(manifest.services)) {
    const entries = [service.variables, service.tunables, service.build_variables].flatMap(listed);
    const shared = (service.inherits ?? []).map((g) => GROUPS[g].title);
    sections.push(
      `### ${SERVICES[key].title}`,
      "",
      SERVICES[key].about + (shared.length ? ` Shared settings it reads: ${shared.join(", ")}.` : ""),
      "",
      ...(entries.length ? table(entries) : ["It has no settings of its own."]),
      "",
    );
  }
  return sections.join("\n");
};
