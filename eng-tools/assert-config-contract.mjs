#!/usr/bin/env node
/** Asserts deployed services' config-contract reports against `config/env-manifest.yaml`. */
import { readFileSync } from "node:fs";
import { loadManifest, observabilityOf, resolveManifest } from "./env-manifest.mjs";

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const targetEnv = envIndex === -1 ? "dev" : args[envIndex + 1];
const files = args.filter((a, i) => a !== "--env" && i !== envIndex + 1 && !a.startsWith("--"));

if (!files.length) {
  console.error("usage: assert-config-contract.mjs [--env dev] <report.json>...");
  process.exit(2);
}

const manifest = loadManifest(process.cwd());
const { effective, services } = resolveManifest(manifest);

const failures = [];
const checked = { presence: 0, value: 0, digest: 0 };
const unverifiable = [];
const undecidable = [];
let quietlyPresenceOnly = 0;

function evaluateRequiredWhen(clause, report) {
  const match = /^\s*([A-Z0-9_]+)\s*(==|!=)\s*(.+?)\s*$/.exec(String(clause));
  if (!match) return undefined;
  const [, governing, op, rawExpected] = match;
  const expected = rawExpected.replace(/^["']|["']$/g, "");

  const reported = report.variables?.[governing];
  if (reported === undefined) return undefined;
  // `true` means set with the value withheld; `false` means unset.
  if (reported === true) return undefined;
  const actual = reported === false ? "" : String(reported);

  return op === "==" ? actual === expected : actual !== expected;
}

function requirement(entry, report) {
  if (entry.required === true || entry.required === "yes") {
    return { required: true, why: `required (fail: ${entry.fail})` };
  }

  const requiredIn = entry.required_in;
  if (Array.isArray(requiredIn) && requiredIn.includes(targetEnv)) {
    return {
      required: true,
      why: `required in ${targetEnv} per required_in: [${requiredIn.join(", ")}] (fail: ${entry.fail})`,
    };
  }

  if (entry.required_when) {
    const holds = evaluateRequiredWhen(entry.required_when, report);
    if (holds === true) {
      return { required: true, why: `required because ${entry.required_when} (fail: ${entry.fail})` };
    }
    if (holds === undefined) {
      undecidable.push(
        `${report.service}.${entry.name ?? "?"} — required_when \`${entry.required_when}\` could not ` +
          `be evaluated (the governing variable is absent from the report or observable by presence only)`
      );
    }
  }

  return { required: false };
}

const reports = new Map();
for (const file of files) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: not valid JSON — ${error.message}`);
    continue;
  }
  if (!report?.service) {
    failures.push(`${file}: report has no "service" field`);
    continue;
  }
  if (report.error) {
    failures.push(`${report.service}: the service itself could not build a report — ${report.error}`);
    continue;
  }
  reports.set(report.service, report);
}

for (const [service, report] of reports) {
  const resolved = effective.get(service);
  if (!resolved) {
    failures.push(`${service}: no such service in the manifest`);
    continue;
  }

  for (const [name, entry] of resolved.allowed) {
    const reported = report.variables?.[name];

    if (reported === undefined) {
      failures.push(
        `${service}: ${name} is declared in the manifest but absent from the report — ` +
          `the running image is older than the contract`
      );
      continue;
    }

    const { required, why: requiredWhy } = requirement({ ...entry, name }, report);
    if (required) {
      const isPresent = reported !== false;
      if (!isPresent) {
        const extra =
          entry.fail === "silent"
            ? " — FAILS SILENTLY, nothing else will tell you"
            : entry.fail === "first-use"
              ? " — the service will boot healthy and fail on first use"
              : "";
        failures.push(`${service}: ${name} is ${requiredWhy}${extra} but is not set`);
        continue;
      }
      checked.presence += 1;
    }

    const expected = entry.envs?.[targetEnv];

    if (expected === "") {
      if (reported === false) {
        checked.value += 1;
      } else {
        failures.push(
          `${service}: ${name} must be EMPTY in ${targetEnv} — the manifest records "" — but the ` +
            `service reports ${reported === true ? "a non-empty value" : JSON.stringify(reported)}`
        );
      }
      continue;
    }

    if (
      observabilityOf(entry) === "value" &&
      expected !== undefined &&
      reported !== false
    ) {
      if (String(reported) !== String(expected)) {
        failures.push(
          `${service}: ${name} is ${JSON.stringify(reported)} but the manifest records ` +
            `${JSON.stringify(String(expected))} for ${targetEnv}`
        );
      } else {
        checked.value += 1;
      }
    } else if (required) {
      if (entry.fail === "silent") {
        unverifiable.push(
          `${service}.${name} — set, but its value is unverifiable here ` +
            (observabilityOf(entry) === "value"
              ? `(no ${targetEnv} value recorded, per decided: Q2)`
              : `(observable: presence)`)
        );
      }
      quietlyPresenceOnly += 1;
    }
  }
}

for (const [groupName, group] of Object.entries(manifest.groups ?? {})) {
  const match = /^identical-across\(([^)]*)\)$/.exec(group.invariant ?? "");
  if (!match) continue;

  const named = match[1].split(",").map((s) => s.trim()).filter(Boolean);
  const present = named.filter((s) => reports.has(s));

  if (present.length < named.length) {
    const missing = named.filter((s) => !reports.has(s));
    failures.push(
      `group ${groupName}: cannot verify its identical-across invariant — no report for ` +
        `${missing.join(", ")}. This is the single most likely misconfiguration in the deployment ` +
        `(§6.4) and it has nothing else detecting it, so a missing report is a failure, not a skip`
    );
    continue;
  }

  const digests = new Map(present.map((s) => [s, reports.get(s).groups?.[groupName]]));
  const distinct = new Set(digests.values());

  if (distinct.has(undefined)) {
    failures.push(
      `group ${groupName}: a report carries no digest for it — ` +
        [...digests].filter(([, d]) => d === undefined).map(([s]) => s).join(", ")
    );
  } else if (distinct.size > 1) {
    failures.push(
      `group ${groupName}: DIGESTS DISAGREE — ` +
        [...digests].map(([s, d]) => `${s}=${d}`).join(", ") +
        `. The writer and the reader are configured differently, so reads will look somewhere ` +
        `nothing was ever written. Nothing else in the system detects this (§6.4)`
    );
  } else {
    checked.digest += 1;
  }
}

const inGha = Boolean(process.env.GITHUB_ACTIONS);
for (const failure of failures) {
  console.log(inGha ? `::error::${failure}` : `  ✗ ${failure}`);
}

if (unverifiable.length) {
  console.log(
    `\n${unverifiable.length} \`fail: silent\` variable(s) verified as present but NOT as correct — ` +
      `these are the ones where a wrong value stays invisible:`
  );
  for (const item of unverifiable.sort()) console.log(`    · ${item}`);
}
if (undecidable.length) {
  console.log(
    `\n${undecidable.length} conditional requirement(s) NOT evaluated — treat as unchecked, not as passing:`
  );
  for (const item of undecidable.sort()) console.log(`    · ${item}`);
}
if (quietlyPresenceOnly - unverifiable.length > 0) {
  console.log(
    `\n${quietlyPresenceOnly - unverifiable.length} further required variable(s) checked for presence ` +
      `only. Not listed: each one fails loudly when wrong (a bad POSTGRES_HOST breaks the first query), ` +
      `so presence is the whole risk.`
  );
}

const scope =
  `${reports.size}/${services.filter(([, s]) => s.config_contract === true).length} services reported; ` +
  `${checked.presence} presence, ${checked.value} value, ${checked.digest} group digest(s) verified`;

console.log(
  failures.length
    ? `\n${failures.length} failure(s). ${scope}`
    : `\n✓ deployed configuration matches the contract for "${targetEnv}". ${scope}`
);

process.exit(failures.length ? 1 : 0);
