#!/usr/bin/env node
/** Static plus the npm advisory database, no AWS. Exits 0 unconditionally — it reports, it never gates. */
import { appendFileSync } from "node:fs";
import { collectAdvisories, SEVERITY_ORDER } from "./advisories.mjs";

const result = collectAdvisories();
if (result.unavailable) {
  console.log(`advisory report unavailable — ${result.unavailable}`);
  process.exit(0);
}
const { rows, reaching, tooling, counts } = result;

const headline =
  `${rows.length} advisor${rows.length === 1 ? "y" : "ies"} — ` +
  SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(", ") +
  `; ${reaching.length} reach${reaching.length === 1 ? "es" : ""} a shipped dependency edge`;

const table = (title, list, note) =>
  list.length === 0
    ? [`### ${title}\n`, "None.\n"]
    : [
        `### ${title}\n`,
        ...(note ? [`${note}\n`] : []),
        "| severity | package | installed | patched | path | advisory |",
        "| :-- | :-- | :-- | :-- | :-- | :-- |",
        ...list.map(
          (r) => `| ${r.severity} | \`${r.module}\` | ${r.installed} | ${r.patched} | \`${r.path}\` | [${r.id}](${r.url}) |`,
        ),
        "",
      ];

const lines = [
  `## Dependency advisories\n`,
  `${headline}.\n`,
  ...table(
    "Reaches a shipped unit",
    reaching,
    "Left the workspace through a `dependencies` edge of an image, the console bundle, or the SDK tarball.",
  ),
  ...table("Build, test, and codegen only", tooling),
  "_Reporting only — this step never fails the run._",
];

console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
