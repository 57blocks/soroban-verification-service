#!/usr/bin/env node
/**
 * The short version is that `packages/config` is imported by three services and should not gain a YAML parser
 * to serve a diagnostic, and that the resolver must stay in one place that needs no build.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, observabilityOf, resolveManifest } from "./env-manifest.mjs";

export const OUTPUT_PATH = "packages/config/src/env-contract.generated.ts";

/** Groups whose members are digested — derived from the invariant, never declared separately. */
export function digestGroups(manifest) {
  return new Set(
    Object.entries(manifest.groups ?? {})
      .filter(([, group]) => /^identical-across\(/.test(group.invariant ?? ""))
      .map(([name]) => name)
  );
}

/** Which services get an endpoint. */
export function contractServices(resolved) {
  return resolved.services.filter(([, svc]) => svc.config_contract === true);
}

export function buildDescriptors(manifest) {
  const resolved = resolveManifest(manifest);
  const digested = digestGroups(manifest);
  const out = {};

  for (const [name] of contractServices(resolved)) {
    const { allowed } = resolved.effective.get(name);
    out[name] = [...allowed.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([varName, entry]) => ({
        name: varName,
        observable: observabilityOf(entry),
        group: entry.group,
        // A secret never contributes to a digest, however stable its group. See check H.
        digest: Boolean(entry.group && digested.has(entry.group) && entry.secret !== true),
      }));
  }
  return out;
}

const ts = (value) => JSON.stringify(value);

export function render(manifest) {
  const descriptors = buildDescriptors(manifest);
  const lines = [
    "// GENERATED FILE — do not edit by hand.",
    "//",
    "// Source:    config/env-manifest.yaml",
    "// Generator: eng-tools/generate-env-contract.mjs  (`pnpm run generate:env-contract`)",
    "//",
    "// `pnpm run check:env` fails when this file disagrees with the manifest, so editing it here is",
    "// not a shortcut — change the manifest and regenerate. What may be reported is a decision that",
    "// belongs in the contract, not in code (ADR-013).",
    "",
    '/** What the diagnostic endpoint may reveal about a variable. */',
    'export type Observability = "presence" | "value";',
    "",
    "export type VariableDescriptor = {",
    "  readonly name: string;",
    "  readonly observable: Observability;",
    "  /** The manifest group this variable came from, when it came from one. */",
    "  readonly group?: string;",
    "  /**",
    "   * True when this variable contributes to its group's digest — i.e. the group carries an",
    "   * `identical-across(...)` invariant and this variable is not a secret.",
    "   */",
    "  readonly digest: boolean;",
    "};",
    "",
    `export const MANIFEST_VERSION = ${ts(manifest.version ?? 1)};`,
    "",
    "/** Service name -> the variables it declares, sorted by name. */",
    "export const ENV_CONTRACT: Readonly<Record<string, readonly VariableDescriptor[]>> = {",
  ];

  for (const [service, descriptors_] of Object.entries(descriptors)) {
    lines.push(`  ${ts(service)}: [`);
    for (const d of descriptors_) {
      const parts = [`name: ${ts(d.name)}`, `observable: ${ts(d.observable)}`];
      if (d.group) parts.push(`group: ${ts(d.group)}`);
      parts.push(`digest: ${d.digest}`);
      lines.push(`    { ${parts.join(", ")} },`);
    }
    lines.push("  ],");
  }

  lines.push("};", "");
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const path = join(root, OUTPUT_PATH);
  const rendered = render(loadManifest(root));

  if (process.argv.includes("--check")) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === rendered) {
      console.log(`✓ ${OUTPUT_PATH} is up to date with the manifest`);
      process.exit(0);
    }
    console.error(
      current === null
        ? `${OUTPUT_PATH} is missing — run \`pnpm run generate:env-contract\``
        : `${OUTPUT_PATH} is stale — run \`pnpm run generate:env-contract\` and commit the result`
    );
    process.exit(1);
  }

  writeFileSync(path, rendered);
  console.log(`wrote ${OUTPUT_PATH}`);
}
