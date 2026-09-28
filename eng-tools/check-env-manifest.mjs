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

const PLATFORM_VARS = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "PWD",
  "CI",
  "NODE_OPTIONS",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "DEV",
  "PROD",
  "MODE",
  "SSR",
  "BASE_URL",
]);

const findings = [];
const report = (check, message) => findings.push({ check, message });

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

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)) yield path;
  }
}

const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[["'`]([A-Z][A-Z0-9_]*)["'`]\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /\b(?:requireEnv|numberEnv|optionalNumberEnv|envString|boolEnv|boundedBulkPageLimit)\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g,
];

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const reads = new Map();
const scanRoots = [
  ...["packages", "services", "clients"].flatMap((tier) =>
    existsSync(join(ROOT, tier))
      ? readdirSync(join(ROOT, tier)).map((pkg) => join(ROOT, tier, pkg, "src"))
      : []
  ),
  join(ROOT, "scripts"),
];

function* containerFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* containerFiles(path);
    else if (/(^|\.)Dockerfile$/.test(name) || name.endsWith(".sh")) yield relative(ROOT, path);
  }
}
const CONTAINER_FILES = [...containerFiles(join(ROOT, "docker"))].sort();
for (const rel of CONTAINER_FILES) {
  const path = join(ROOT, rel);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
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

const dtoFiles = [
  "packages/config/src/env.dto.ts",
  ...services.map(([, svc]) => svc.env_dto).filter(Boolean),
];

const classes = new Map();
const fileClasses = new Map();

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

function dtoFields(className, seen = new Set()) {
  if (!className || seen.has(className)) return new Set();
  seen.add(className);
  const cls = classes.get(className);
  if (!cls) return new Set();
  return new Set([...cls.fields, ...dtoFields(cls.extends, seen)]);
}

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

for (const name of [...manifestNames].sort()) {
  if (reads.has(name) || forbiddenOnly.has(name)) continue;
  report(
    "B staleness",
    `${name} is declared in ${MANIFEST} but read nowhere in the codebase — retire it or delete it`
  );
}

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
    if (allowed.get(varName).dto_exempt === true) continue;
    report(
      "C dto-missing",
      `${name}: ${varName} is declared in the manifest (via ${allowed.get(varName).origin}) ` +
        `but ${declared[0]} does not validate it — a malformed value is accepted silently`
    );
  }
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

const RETIRED_SCAN = [
  ".env.example",
  ...services.map(([name]) => `services/${name}/.env.example`),
  ...IMAGE_FILES,
];
for (const name of [...retired].sort()) {
  if (manifestNames.has(name)) {
    report("F retired", `${name} is listed as retired and also declared as live in ${MANIFEST}`);
  }
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

const OBSERVABILITY = ["presence", "value"];

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

const TIER_INJECT = {
  secret: ["ecs-secrets"],
  infrastructure: ["ecs-secrets"],
  knob: [
    "ecs-secrets",
    "batch-job-definition",
    "batch-container-environment",
    "batch-submit-job",
    "ecs-run-task-override",
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

    if (declared === undefined && entry.secret === true) {
      report(
        "J tier",
        `${where}: ${varName} is secret: true but declares no tier. Only \`knob\` may be implicit`
      );
      continue;
    }
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
    if (entry.deploy !== "never" && tier === "secret" && !entry.secret_ref?.name) {
      report(
        "J tier",
        `${where}: ${varName} is tier: secret but has no secret_ref.name — ` +
          `nothing can construct its secrets[].valueFrom`
      );
    }
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

const counts = new Map();
for (const { check } of findings) counts.set(check, (counts.get(check) ?? 0) + 1);

for (const { check, message } of findings) {
  const line = `${check}: ${message}`;
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
