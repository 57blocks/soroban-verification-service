#!/usr/bin/env node
/** Three-way drift check over the environment variable contract. */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  entriesOf,
  loadManifest,
  MANIFEST_PATH,
  observabilityOf,
  resolveManifest,
} from "./env-manifest.mjs";
import { OUTPUT_PATH, render } from "./generate-env-contract.mjs";
import { buildArtifacts, OUTPUT_DIR } from "./generate-deploy-env.mjs";

const ROOT = process.cwd();
const MANIFEST = MANIFEST_PATH;

/** Variables the platform supplies, which are therefore not part of anyone's contract. */
const PLATFORM_VARS = new Set([
  "HOME",      // run-cli.ts's `$HOME/.local/share` fallback for the Stellar CLI's data dir
  "TMPDIR",
  "PATH",
  // A POSIX shell builtin, not configuration: the shell always sets it, so no task definition or manifest entry
  // can.
  "PWD",
  "CI",
  "NODE_OPTIONS",
  // The Rust toolchain's own convention, set by `ENV` in docker/composed-environments/*/Dockerfile and consumed
  // two lines later.
  "RUSTUP_HOME",
  "CARGO_HOME",
  // Vite's own `import.meta.env` members, injected by the bundler. Nobody sets these.
  "DEV",
  "PROD",
  "MODE",
  "SSR",
  "BASE_URL",
]);

const findings = [];
const report = (check, message) => findings.push({ check, message });

// ── read and resolve the manifest ───────────────────────────────────────────────────────────────
// The composition rules (`groups`/`inherits`/`forbidden`) live in ./env-manifest.mjs, shared with
// generate-env-contract.mjs so there is exactly one implementation of what the manifest means.

let manifest;
try {
  manifest = loadManifest(ROOT);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const { services, effective, manifestNames, forbiddenOnly, retired, problems } =
  resolveManifest(manifest);

for (const problem of problems) report("schema", problem);

// ── scan the code ───────────────────────────────────────────────────────────────────────────────

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)) yield path;
  }
}

/** `import.meta.env` is Vite's, not Node's, so the second alternative is not redundant. */
const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[["'`]([A-Z][A-Z0-9_]*)["'`]\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /\b(?:requireEnv|numberEnv|optionalNumberEnv|envString|boolEnv|boundedBulkPageLimit)\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g,
];

/** Comments are not reads. */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** name → Set of repo-relative files that read it. */
const reads = new Map();
const scanRoots = [
  ...["packages", "services", "clients"].flatMap((tier) =>
    existsSync(join(ROOT, tier))
      ? readdirSync(join(ROOT, tier)).map((pkg) => join(ROOT, tier, pkg, "src"))
      : []
  ),
  join(ROOT, "scripts"),
];

/**
 * Dockerfiles and container entrypoints, because a variable consumed by a container CMD is invisible to a `.ts`
 * scan.
 */
function* containerFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* containerFiles(path);
    // `Dockerfile` as well as `*.Dockerfile`: docker/composed-environments/v*/Dockerfile are three images this
    // repo owns, and they read build inputs like ${BASE_IMAGE} and ${RSVER}.
    else if (/(^|\.)Dockerfile$/.test(name) || name.endsWith(".sh")) yield relative(ROOT, path);
  }
}
const CONTAINER_FILES = [...containerFiles(join(ROOT, "docker"))].sort();
for (const rel of CONTAINER_FILES) {
  const path = join(ROOT, rel);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  // A name the file declares with `ARG` is skipped WHERE IT IS CONSUMED: an `ARG` is a build input the builder
  // supplies, so no task definition can set it.
  const buildArgs = new Set(
    lines.flatMap((line) => [...line.matchAll(/^\s*ARG\s+([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name))
  );
  const assignedHere = rel.endsWith(".sh")
    ? new Set(
        [...text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*)=(.*)$/gm)]
          .filter(([, name, rhs]) => !new RegExp(`\\$\\{?${name}\\b`).test(rhs))
          .map(([, name]) => name),
      )
    : new Set();
  for (const line of lines) {
    if (/^\s*(?:ENV|ARG)\b/.test(line) || /^\s*#/.test(line)) continue;
    // Every `${VAR...}` form, not just `${VAR}` and `${VAR:-x}`.
    for (const [, a, b] of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)[^}]*\}|\$([A-Z][A-Z0-9_]*)/g)) {
      const name = a ?? b;
      if (buildArgs.has(name) || assignedHere.has(name)) continue;
      if (!reads.has(name)) reads.set(name, new Set());
      reads.get(name).add(rel);
    }
  }
}

for (const dir of scanRoots) {
  for (const file of walk(dir)) {
    const text = stripComments(readFileSync(file, "utf8"));
    const rel = relative(ROOT, file);
    for (const pattern of READ_PATTERNS) {
      for (const [, name] of text.matchAll(pattern)) {
        if (!reads.has(name)) reads.set(name, new Set());
        reads.get(name).add(rel);
      }
    }
  }
}

// ── parse the DTO chains ────────────────────────────────────────────────────────────────────────

/**
 * Regex rather than the TypeScript compiler API on purpose: the shape being read is four lines of `export class
 * X extends Y { FIELD?: string }` per file, and pulling in `typescript` as a runtime dependency of a hygiene
 * check would cost more than it buys.
 */
const dtoFiles = [
  "packages/config/src/env.dto.ts",
  ...services.map(([, svc]) => svc.env_dto).filter(Boolean),
];

const classes = new Map(); // className -> { fields: string[], extends?: string, file }
const fileClasses = new Map(); // file -> className[]

for (const rel of new Set(dtoFiles)) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    report("schema", `manifest names env_dto ${rel}, which does not exist`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const declared = [];
  const classRe = /export class (\w+)(?:\s+extends\s+(\w+))?\s*\{([\s\S]*?)\n\}/g;
  for (const [, className, parent, body] of text.matchAll(classRe)) {
    const fields = [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)[?!]?\s*:/gm)].map(([, f]) => f);
    classes.set(className, { fields, extends: parent, file: rel });
    declared.push(className);
  }
  fileClasses.set(rel, declared);
}

/** Field names a class validates, following `extends` as far as it resolves. */
function dtoFields(className, seen = new Set()) {
  if (!className || seen.has(className)) return new Set();
  seen.add(className);
  const cls = classes.get(className);
  if (!cls) return new Set();
  return new Set([...cls.fields, ...dtoFields(cls.extends, seen)]);
}

// ── A: every variable read in code is declared in the manifest ──────────────────────────────────

for (const [name, files] of [...reads].sort()) {
  if (PLATFORM_VARS.has(name) || manifestNames.has(name)) continue;
  if (retired.has(name)) {
    report("F retired", `${name} is listed as retired but still read in ${[...files].join(", ")}`);
    continue;
  }
  report(
    "A coverage",
    `${name} is read in ${[...files].sort().join(", ")} but declared nowhere in ${MANIFEST}`
  );
}

// ── B: every variable declared in the manifest is read in code ──────────────────────────────────

for (const name of [...manifestNames].sort()) {
  if (reads.has(name) || forbiddenOnly.has(name)) continue;
  report(
    "B staleness",
    `${name} is declared in ${MANIFEST} but read nowhere in the codebase — retire it or delete it`
  );
}

// ── C/D: the manifest and each service's boot validation agree ──────────────────────────────────

for (const [name, svc] of services) {
  if (!svc.env_dto) continue;
  const declared = fileClasses.get(svc.env_dto) ?? [];
  if (declared.length !== 1) {
    report(
      "schema",
      `${svc.env_dto} declares ${declared.length} exported classes; expected exactly one`
    );
    continue;
  }
  const validated = dtoFields(declared[0]);
  const { allowed } = effective.get(name);

  for (const varName of [...allowed.keys()].sort()) {
    if (validated.has(varName)) continue;
    // `dto_exempt` means the service process genuinely never reads it.
    if (allowed.get(varName).dto_exempt === true) continue;
    report(
      "C dto-missing",
      `${name}: ${varName} is declared in the manifest (via ${allowed.get(varName).origin}) ` +
        `but ${declared[0]} does not validate it — a malformed value is accepted silently`
    );
  }
  // A DTO chain can be coarser than the manifest, because TypeScript has single inheritance and the manifest's
  // groups compose freely.
  const overDeclared = new Set(svc.dto_over_declares ?? []);
  for (const varName of [...validated].sort()) {
    if (allowed.has(varName) || overDeclared.has(varName)) continue;
    report(
      "D dto-extra",
      `${name}: ${declared[0]} validates ${varName}, which the manifest does not declare for this service`
    );
  }
  for (const [varName, entry] of allowed) {
    if (entry.dto_exempt === true && validated.has(varName)) {
      report(
        "D dto-extra",
        `${name}: ${varName} is dto_exempt but ${declared[0]} validates it — drop the exemption`
      );
    }
  }
  for (const varName of [...overDeclared].sort()) {
    if (allowed.has(varName)) {
      report(
        "D dto-extra",
        `${name}: ${varName} is listed in dto_over_declares but the manifest does declare it — drop the exemption`
      );
    } else if (!validated.has(varName)) {
      report(
        "D dto-extra",
        `${name}: ${varName} is listed in dto_over_declares but ${declared[0]} does not validate it — drop the exemption`
      );
    }
  }
}

// ── E: a service never reads what its manifest block forbids (ADR-002) ──────────────────────────

for (const [name, svc] of services) {
  const { forbidden } = effective.get(name);
  if (!forbidden.size) continue;
  const ownSource = join(ROOT, "services", name, "src");
  if (!existsSync(ownSource)) continue;

  for (const varName of [...forbidden].sort()) {
    const offenders = [...(reads.get(varName) ?? [])].filter((f) =>
      f.startsWith(`services/${name}/src`)
    );
    if (offenders.length) {
      report(
        "E forbidden",
        `TRUST BOUNDARY: ${name} reads ${varName}, which its manifest block forbids — ` +
          `${offenders.sort().join(", ")}` +
          (svc.trust_boundary ? `\n           ${svc.trust_boundary.split("\n")[0].trim()}` : "")
      );
    }
  }
}

// Same list, against the image definitions this repo does own. Every container file, not only the Dockerfiles.
const IMAGE_FILES = CONTAINER_FILES;
const builderForbidden = effective.get("builder")?.forbidden ?? new Set();
for (const rel of IMAGE_FILES) {
  const path = join(ROOT, rel);
  if (!existsSync(path) || !rel.includes("builder")) continue;
  const text = readFileSync(path, "utf8");
  for (const varName of builderForbidden) {
    if (new RegExp(`^\\s*(?:ENV|ARG)\\s+${varName}\\b`, "m").test(text)) {
      report("E forbidden", `TRUST BOUNDARY: ${rel} sets ${varName}, forbidden for the builder`);
    }
  }
}

// ── F: a retired variable appears nowhere it could be mistaken for live ─────────────────────────

const RETIRED_SCAN = [
  ".env.example",
  ...services.map(([name]) => `services/${name}/.env.example`),
  ...IMAGE_FILES,
];
for (const name of [...retired].sort()) {
  if (manifestNames.has(name)) {
    report("F retired", `${name} is listed as retired and also declared as live in ${MANIFEST}`);
  }
  // A `forbidden:` list naming a retired variable.
  for (const [svcName, svc] of services) {
    if ((svc.forbidden ?? []).includes(name)) {
      report(
        "F retired",
        `${svcName}: ${name} is retired but still named in its forbidden: list — a list that denies a ` +
          `variable nothing can set is not a control, and reads exactly like one that still holds. ` +
          `Replace it with whatever carries the capability now`
      );
    }
  }
  for (const rel of RETIRED_SCAN) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    if (new RegExp(`^\\s*(?:ENV\\s+|ARG\\s+)?${name}\\s*=`, "m").test(readFileSync(path, "utf8"))) {
      report(
        "F retired",
        `${name} is retired but still set in ${rel} — ${manifest.retired[name]?.action ?? "remove it"}`
      );
    }
  }
}

// ── H: the observability boundary is coherent, and cannot leak a secret ─────────────────────────
// It is deliberately data in the manifest rather than logic in a service, so widening it is visible in a diff
// of that file.

const OBSERVABILITY = ["presence", "value"];

// Iterate DECLARATION SITES, not resolved per-service sets.
const declarationSites = [
  ...Object.entries(manifest.groups ?? {}).map(([g, gv]) => [`group ${g}`, gv.variables]),
  ...services.flatMap(([name, svc]) =>
    [
      ["variables", svc.variables],
      ["tunables", svc.tunables],
      ["build_variables", svc.build_variables],
    ].map(([block, vars]) => [`${name}.${block}`, vars])
  ),
];

for (const [where, block] of declarationSites) {
  for (const [varName, entry] of entriesOf(block)) {
    if (!entry || typeof entry !== "object") continue;
    const observable = observabilityOf(entry);

    if (!OBSERVABILITY.includes(observable)) {
      report(
        "H observable",
        `${where}: ${varName} has observable: "${observable}" — must be one of ${OBSERVABILITY.join(", ")}`
      );
      continue;
    }
    if (entry.secret === true && observable !== "presence") {
      report(
        "H observable",
        `SECRET LEAK: ${where}: ${varName} is secret: true and observable: ${observable} — ` +
          `a secret may only ever be reported as presence, and never digested (a password hash is a ` +
          `cracking target, not a redaction)`
      );
    }
    if (observable === "value" && !Array.isArray(entry.values)) {
      report(
        "H observable",
        `${where}: ${varName} is observable: value but declares no \`values:\` — only an enumerated ` +
          `variable may report its value, so that a free-text value cannot become reportable without ` +
          `someone inventing an enum for it in review`
      );
    }
  }
}

// A digest is derived from `invariant: identical-across(...)`, so a group carrying that invariant with no
// digestible member would emit a constant.
for (const [groupName, group] of Object.entries(manifest.groups ?? {})) {
  if (!/^identical-across\(/.test(group.invariant ?? "")) continue;
  const digestible = entriesOf(group.variables).filter(
    ([, entry]) => entry?.secret !== true && entry?.required !== "forbidden"
  );
  if (!digestible.length) {
    report(
      "H observable",
      `group ${groupName} carries an identical-across invariant but has no non-secret member to ` +
        `digest — the cross-service comparison would be vacuously equal`
    );
  }
}

// ── G: an identical-across invariant names services that really do inherit the group ────────────

for (const [groupName, group] of Object.entries(manifest.groups ?? {})) {
  const match = /^identical-across\(([^)]*)\)$/.exec(group.invariant ?? "");
  if (!match) continue;
  const named = match[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (named.length < 2) {
    report("G invariant", `group ${groupName}: identical-across needs at least two services`);
  }
  for (const svcName of named) {
    const svc = manifest.services?.[svcName];
    if (!svc) {
      report("G invariant", `group ${groupName}: invariant names unknown service ${svcName}`);
    } else if (!(svc.inherits ?? []).includes(groupName)) {
      report(
        "G invariant",
        `group ${groupName}: invariant names ${svcName}, which does not inherit the group — ` +
          `the invariant is decorative as written`
      );
    }
  }
}

// ── K: a declared relationship between two forbidden lists actually holds ───────────────────────
// Same failure shape as check G, a claimed invariant nothing enforces, and note that "remember to update both
// lists" would not have helped here.

for (const [name, svc] of services) {
  const base = svc.forbidden_superset_of;
  if (base === undefined) continue;
  if (typeof base !== "string" || !manifest.services?.[base]) {
    report("K superset", `${name}: forbidden_superset_of names unknown service ${JSON.stringify(base)}`);
    continue;
  }
  if (base === name) {
    report("K superset", `${name}: forbidden_superset_of names itself — vacuously true`);
    continue;
  }
  const mine = effective.get(name)?.forbidden ?? new Set();
  const theirs = effective.get(base)?.forbidden ?? new Set();
  const missing = [...theirs].filter((varName) => !mine.has(varName)).sort();
  if (missing.length) {
    report(
      "K superset",
      `TRUST BOUNDARY: ${name} declares forbidden_superset_of: ${base} but does not forbid ` +
        `${missing.join(", ")} — ${base} does. Either add ${missing.length === 1 ? "it" : "them"} or ` +
        `drop the declaration; a relationship stated and not held is worse than one never claimed`
    );
  }
}

// ── J: tier and injection mechanism agree (ADR-016, remapped by ADR-025) ───────────────────────
// `tier:` is the reviewable statement — "what does this disclose?" — and `inject:` is the mechanism that
// follows from it.

const TIER_INJECT = {
  secret: ["ecs-secrets"],
  infrastructure: ["ecs-secrets"],
  knob: [
    "ecs-secrets",
    "batch-job-definition",
    "batch-container-environment",
    "batch-submit-job",   // per-invocation job params — a spec, nothing to protect
    "docker-build-arg",
  ],
};

for (const [where, block] of declarationSites) {
  for (const [varName, entry] of entriesOf(block)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.required === "forbidden" || entry.inject === "none") continue;

    const declared = entry.tier;
    const tier = declared ?? "knob";

    if (declared !== undefined && !(tier in TIER_INJECT)) {
      report("J tier", `${where}: ${varName} has tier: "${tier}" — must be one of ${Object.keys(TIER_INJECT).join(", ")}`);
      continue;
    }

    // A non-knob tier must be stated. `knob` is the default precisely because it is the tier with nothing to
    // protect; anything else is a claim someone should have made deliberately.
    if (declared === undefined && entry.secret === true) {
      report(
        "J tier",
        `${where}: ${varName} is secret: true but declares no tier. Only \`knob\` may be implicit`
      );
      continue;
    }
    // A CI-generated secret is the third category ADR-025's two-tier table does not have: the value is
    // secret, but no human writes it, so it lives in the config secret CI owns rather than naming a
    // credential CI has no grant on. `generate:` is what makes that claim checkable — without it,
    // `secret: true` outside tier `secret` is still what it always was, a value in the wrong store.
    const isGeneratedSecret = tier === "infrastructure" && typeof entry.generate === "string";
    if (entry.secret === true && tier !== "secret" && !isGeneratedSecret) {
      report("J tier", `${where}: ${varName} is secret: true but tier: ${tier} — a secret is tier: secret`);
    }
    if (entry.generate !== undefined) {
      if (!isGeneratedSecret) {
        report(
          "J tier",
          `${where}: ${varName} declares generate: but is tier: ${tier} — CI can only mint into the ` +
            `config secret it owns, which is tier: infrastructure`
        );
      }
      if (entry.secret !== true) {
        report(
          "J tier",
          `${where}: ${varName} declares generate: but is not secret: true — a value worth minting ` +
            `randomly is a value worth keeping out of the config-contract report`
        );
      }
      // Anything that pins the value defeats the point: CI would write the pinned one and the mint
      // would never run, silently.
      for (const pin of ["value", "envs", "value_from_output", "value_ref"]) {
        if (entry[pin] !== undefined) {
          report(
            "J tier",
            `${where}: ${varName} declares generate: and ${pin}: — a generated value may not also be ` +
              `pinned, or the pin wins and nothing is ever minted`
          );
        }
      }
    }
    // Only tier `secret` names its secret here.
    if (entry.deploy !== "never" && tier === "secret" && !entry.secret_ref?.name) {
      report(
        "J tier",
        `${where}: ${varName} is tier: secret but has no secret_ref.name — ` +
          `nothing can construct its secrets[].valueFrom`
      );
    }
    // `deploy: never` entries are not injected anywhere, so their `inject:` is documentation only.
    if (entry.deploy === "never" || entry.inject === undefined) continue;
    if (!TIER_INJECT[tier].includes(entry.inject)) {
      report(
        "J tier",
        `${where}: ${varName} is tier: ${tier} but inject: ${entry.inject} — expected ` +
          `${TIER_INJECT[tier].join(" or ")} (ADR-016)`
      );
    }
  }
}

// ── M: a `source: terraform` entry can actually be resolved at deploy time (ADR-025) ───────────
// `value_from_output:` is a JSON path into `/scvs/<env>/ci/descriptor`.

for (const [where, block] of declarationSites) {
  for (const [varName, entry] of entriesOf(block)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.source !== "terraform") continue;
    if (entry.required === "forbidden" || entry.deploy === "never") continue;
    if (!["ecs-secrets", "batch-job-definition", "batch-container-environment"].includes(entry.inject)) continue;

    if (typeof entry.value_from_output !== "string" || !entry.value_from_output.trim()) {
      report(
        "M resolvable",
        `${where}: ${varName} is source: terraform but declares no value_from_output — CI cannot ` +
          `resolve it from /scvs/<env>/ci/descriptor, so it would reach the process unset (ADR-025)`
      );
    }
  }
}

// ── L: a runtime `required: yes` whose contracted value is EMPTY cannot be satisfied ────────────
// The config contract reports presence as NON-EMPTY (`packages/config/src/config-contract.ts`'s `isSet`),
// because that is what the reading code does: `SCVS_PUBLISHER_PREFIX` goes through `|| ""` and cannot tell
// unset from empty either.

const RUNTIME_INJECT = ["ecs-secrets"];

for (const [where, block] of declarationSites) {
  for (const [varName, entry] of entriesOf(block)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.required !== true && entry.required !== "yes") continue;
    if (entry.deploy === "never" || !RUNTIME_INJECT.includes(entry.inject)) continue;

    const empty = (manifest.meta?.environments ?? []).filter((env) => entry.envs?.[env] === "");
    if (empty.length) {
      report(
        "L satisfiable",
        `${where}: ${varName} is required: yes but the manifest records an EMPTY value for ` +
          `${empty.join(", ")} — presence means non-empty, so no deployment can satisfy both. ` +
          `Use \`required: no\`; assert-config-contract.mjs asserts the emptiness in its own right`
      );
    }
  }
}

// ── I: the committed descriptor still matches the manifest ─────────────────────────────────────
// The endpoint serves a generated file rather than reading the manifest at runtime (see the feature's
// decisions/resolver-lives-in-eng-tools.md), so the one failure that design introduces is the file going stale.

{
  const path = join(ROOT, OUTPUT_PATH);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  const expected = render(manifest);
  if (current === null) {
    report("I generated", `${OUTPUT_PATH} is missing — run \`pnpm run generate:env-contract\``);
  } else if (current !== expected) {
    report(
      "I generated",
      `${OUTPUT_PATH} no longer matches ${MANIFEST} — run \`pnpm run generate:env-contract\` and ` +
        `commit the result. Editing the generated file by hand is not a shortcut: what may be ` +
        `reported is a decision that belongs in the manifest (ADR-013)`
    );
  }
}

// The same staleness rule for the per-service deploy artifacts DevOps's Terraform reads.
for (const [rel, expected] of buildArtifacts(manifest)) {
  const path = join(ROOT, rel);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === null) {
    report("I generated", `${rel} is missing — run \`pnpm run generate:deploy-env\``);
  } else if (current !== expected) {
    report(
      "I generated",
      `${rel} no longer matches ${MANIFEST} — run \`pnpm run generate:deploy-env\` and commit it. ` +
        `DevOps reads these; a stale one is a contract another repository applies without knowing`
    );
  }
}

// A service must not acquire a diagnostic endpoint by accident, and the sandbox must never have one.
for (const [name, svc] of services) {
  if (svc.config_contract !== true) continue;
  if (name === "builder") {
    report(
      "I generated",
      `TRUST BOUNDARY: builder declares config_contract: true — the sandbox must never serve a ` +
        `configuration report (ADR-002); it has no HTTP listener and no configuration worth reporting`
    );
  }
  if (!svc.env_dto) {
    report(
      "I generated",
      `${name} declares config_contract: true but has no env_dto — a service with no boot validation ` +
        `has nothing coherent to report`
    );
  }
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────

const counts = new Map();
for (const { check } of findings) counts.set(check, (counts.get(check) ?? 0) + 1);

for (const { check, message } of findings) {
  const line = `${check}: ${message}`;
  // GitHub Actions renders `::error::` in the job summary and annotates the run.
  console.log(process.env.GITHUB_ACTIONS ? `::error::${line}` : `  ✗ ${line}`);
}

const scanned = reads.size;
console.log(
  findings.length
    ? `\n${findings.length} finding(s) across ${[...counts.keys()].sort().join(", ")}` +
        `\n${MANIFEST} declares ${manifestNames.size} variables; the code reads ${scanned}.`
    : `✓ env contract consistent — ${manifestNames.size} variables declared in ${MANIFEST}, ` +
        `${scanned} read in code, ${services.length} services cross-checked against their env DTOs.`
);

process.exit(findings.length ? 1 : 0);
