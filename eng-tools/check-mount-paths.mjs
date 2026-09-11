#!/usr/bin/env node
/** Static and read-only: parses `.github/workflows/deploy-builder.yml` and `deploy-composer.yml` from disk. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One workflow file's job-definition registration to check. */
const TARGETS = [
  { label: "builder", path: ".github/workflows/deploy-builder.yml" },
  { label: "composer", path: ".github/workflows/deploy-composer.yml" },
];

const findings = [];
let mountsChecked = 0;

for (const { label, path } of TARGETS) {
  const full = join(repoRoot, path);
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    findings.push(`${label}: could not read ${path} — has it moved?`);
    continue;
  }

  // The registration call's JSON blob is embedded in a shell heredoc with `${...}` interpolations, so it is not
  // valid JSON on its own.
  const scannable = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  // Two spellings, because the properties are now assigned to a shell variable and asserted by
  // check-taskdef-boundary.mjs before being passed to register-job-definition (invariants.md rule 23).
  // The flag form is kept so this keeps working if a workflow ever inlines the blob again.
  const blobMatch =
    scannable.match(/--(?:ecs|container)-properties\s+"\{([\s\S]*?)\}"\s*\\/) ??
    scannable.match(/(?:ECS|CONTAINER)_PROPERTIES="\{([\s\S]*?)\}"\s*$/m);
  if (!blobMatch) {
    findings.push(
      `${label}: no properties block found in ${path} — expected either ` +
        `\`--ecs/container-properties "{...}"\` or \`ECS/CONTAINER_PROPERTIES="{...}"\``
    );
    continue;
  }
  const blob = blobMatch[1];

  // Every volume this blob declares that carries a host bind path: { name -> sourcePath }.
  const hostVolumes = new Map();
  for (const m of blob.matchAll(
    /\\"name\\":\s*\\"([^"\\]+)\\",\s*\\"host\\":\s*\{\\"sourcePath\\":\s*\\"([^"\\]+)\\"\}/g,
  )) {
    hostVolumes.set(m[1], m[2]);
  }

  // Every volume name declared at all, host-backed or not — so a mount pointing at a Docker-managed volume is
  // told apart from one pointing at a name that does not exist.
  const declaredVolumes = new Set(
    [...blob.matchAll(/\\"name\\":\s*\\"([^"\\]+)\\",\s*\\"host\\":/g)].map((m) => m[1]),
  );

  // Every mount point: { sourceVolume, containerPath }.
  const mountPoints = [
    ...blob.matchAll(
      /\\"sourceVolume\\":\s*\\"([^"\\]+)\\",\s*\\"containerPath\\":\s*\\"([^"\\]+)\\"/g,
    ),
  ].map((m) => ({ sourceVolume: m[1], containerPath: m[2] }));

  if (mountPoints.length === 0) {
    findings.push(
      `${label}: no mountPoints found in ${path} — cannot check CE3. Both job definitions must ` +
        `bind-mount the docker socket and a shared /tmp, so finding none means this parser lost the ` +
        `blob rather than that there is nothing to check`,
    );
    continue;
  }

  for (const { sourceVolume, containerPath } of mountPoints) {
    mountsChecked += 1;
    if (!declaredVolumes.has(sourceVolume)) {
      findings.push(
        `${label}: mountPoint at ${containerPath} references volume "${sourceVolume}", which this ` +
          `definition does not declare — the mount would fail to register`,
      );
      continue;
    }
    const hostPath = hostVolumes.get(sourceVolume);
    if (hostPath === undefined) {
      findings.push(
        `${label}: volume "${sourceVolume}", mounted at ${containerPath}, declares no ` +
          `host.sourcePath — a Docker-managed volume, which is exactly the trap that produces an ` +
          `empty mount and "could not find Cargo.toml in /source"`,
      );
      continue;
    }
    if (hostPath !== containerPath) {
      findings.push(
        `${label}: volume "${sourceVolume}" binds host path ${hostPath} at container path ` +
          `${containerPath} — these must be IDENTICAL (CE3). The runner hands this path to the ` +
          `HOST's daemon, which resolves it against the host filesystem, so a differing pair mounts ` +
          `somewhere nobody intended`,
      );
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────

const inGha = Boolean(process.env.GITHUB_ACTIONS);
for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);

console.log(
  findings.length
    ? `\n${findings.length} CE3 finding(s) across ${TARGETS.length} workflow file(s). Every volume a ` +
        `job definition bind-mounts must be host-visible at its own path, because the runner hands ` +
        `that path to the host's daemon.`
    : `✓ CE3 holds: ${mountsChecked} bind mount(s) across ${TARGETS.length} workflow file(s) are ` +
        `host-visible at identical paths.`,
);
process.exit(findings.length ? 1 : 0);
