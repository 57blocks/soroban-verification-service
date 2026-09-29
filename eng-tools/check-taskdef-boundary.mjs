#!/usr/bin/env node
/** Asserts a rendered task/job definition against the trust boundary before it is registered. Fails closed. */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const targetEnv = flag("env", "dev");
const service = flag("service");
const files = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

if (!service || files.length !== 1) {
  console.error(
    "usage: check-taskdef-boundary.mjs --env <env> --service <name> [--contract <path>] [--target-contract <path>] <rendered-taskdef.json>"
  );
  process.exit(2);
}

const ROOT = process.cwd();
const contractPath = flag("contract")
  ? resolve(flag("contract"))
  : join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
if (!existsSync(contractPath)) {
  console.error(
    `::error::no deployment contract at config/deploy/${targetEnv}/${service}.json — ` +
      `cannot assert the trust boundary for a service it does not describe`
  );
  process.exit(1);
}

const contract = JSON.parse(readFileSync(contractPath, "utf8"));

let rendered;
try {
  rendered = JSON.parse(readFileSync(files[0], "utf8"));
} catch (error) {
  console.error(`::error::${files[0]} is not readable JSON: ${error.message}`);
  process.exit(1);
}

const failures = [];
const fail = (rule, message) => failures.push(`${rule}: ${message}`);

// Walk every shape rather than branch on `kind`: an unrecognised nesting must not go unchecked.

const environment = new Map();
const secretRefs = new Map();
const containers = [];

function collectContainer(container, where) {
  if (!container || typeof container !== "object") return;
  containers.push({ container, where });
  for (const entry of container.environment ?? []) {
    if (entry?.name !== undefined) environment.set(entry.name, entry.value);
  }
  for (const entry of container.secrets ?? []) {
    if (entry?.name !== undefined) secretRefs.set(entry.name, entry.valueFrom);
  }
}

for (const [i, c] of (rendered.containerDefinitions ?? []).entries()) {
  collectContainer(c, `containerDefinitions[${i}]`);
}
collectContainer(rendered.containerProperties, "containerProperties");
for (const [i, node] of (rendered.nodeProperties?.nodeRangeProperties ?? []).entries()) {
  collectContainer(node?.container, `nodeProperties[${i}].container`);
}
for (const [i, task] of (rendered.ecsProperties?.taskProperties ?? []).entries()) {
  for (const [j, c] of (task?.containers ?? []).entries()) {
    collectContainer(c, `ecsProperties.taskProperties[${i}].containers[${j}]`);
  }
}

if (!containers.length) {
  fail(
    "shape",
    `${files[0]} has no containerDefinitions, containerProperties, ecsProperties, or nodeProperties — ` +
      `nothing to check, which is a failure rather than a pass`
  );
}

const declared = new Set([...environment.keys(), ...secretRefs.keys()]);

const prohibitions = [
  ["forbidden", contract.forbidden?.variables ?? [], "ADR-002 trust boundary"],
  ["per_invocation", contract.per_invocation?.variables ?? [], "injected at SubmitJob time"],
  ["not_in_deployment", contract.not_in_deployment?.variables ?? [], "valid locally, wrong deployed"],
];

for (const [section, names, why] of prohibitions) {
  for (const name of names) {
    if (declared.has(name)) {
      const via = secretRefs.has(name) ? "secrets" : "environment";
      fail(
        section,
        `TRUST BOUNDARY: ${service} must not be given ${name}, but the rendered document sets it ` +
          `via ${via} (${why})`
      );
    }
  }
}

// Builder only: the composer is Batch too, but it is trusted and needs its job role.
const SANDBOX_SERVICES = new Set(["builder"]);

if (contract.kind === "batch-job-definition" && SANDBOX_SERVICES.has(service)) {
  // `ecsProperties` grants its role on the task, one level above the containers the loop below sees.
  for (const [i, task] of (rendered.ecsProperties?.taskProperties ?? []).entries()) {
    if (task?.taskRoleArn) {
      fail(
        "jobRoleArn",
        `TRUST BOUNDARY: ${service} is a Batch job definition and must hold no business credentials, ` +
          `but ecsProperties.taskProperties[${i}] carries taskRoleArn=${task.taskRoleArn} (ADR-002)`
      );
    }
  }
  for (const { container, where } of containers) {
    if (container.jobRoleArn) {
      fail(
        "jobRoleArn",
        `TRUST BOUNDARY: ${service} is a Batch job definition and must hold no business credentials, ` +
          `but ${where} carries jobRoleArn=${container.jobRoleArn} (ADR-002)`
      );
    }
  }
  if (secretRefs.size) {
    fail(
      "batch-secrets",
      `TRUST BOUNDARY: ${service} is a Batch job definition and must not reference secrets ` +
        `(${[...secretRefs.keys()].join(", ")}) — reading one requires a grant its execution role ` +
        `does not and must not have (ADR-002, ADR-025 decision 1)`
    );
  }
}

const storedByTarget = contract.secrets?.stores_of === "target";
let storeContract = contract;
if (storedByTarget) {
  const targetPath = flag("target-contract");
  if (!targetPath || !existsSync(targetPath)) {
    console.error(
      `::error::${service}'s values live in its target's stores, so --target-contract must name that ` +
        `service's contract (got ${targetPath ?? "none"})`
    );
    process.exit(1);
  }
  storeContract = JSON.parse(readFileSync(targetPath, "utf8"));

  const allowed = new Set([
    ...Object.keys(contract.secrets?.variables ?? {}),
    ...Object.keys(contract.environment ?? {}),
  ]);
  for (const name of declared) {
    if (!allowed.has(name)) {
      fail("allowlist", `${name} is not a variable ${service}'s contract declares, so it must not be in its task definition`);
    }
  }
  if (rendered.taskRoleArn) {
    fail("taskRoleArn", `${service} must run with no task role, but the rendered document carries ${rendered.taskRoleArn}`);
  }
  for (const { container, where } of containers) {
    if (container.user && container.user !== "node") {
      fail("user", `${where} runs as ${container.user}; ${service} runs as the image's own user`);
    }
  }
}

const allowedSecretNames = new Set();
if (storeContract.secrets?.config_secret) allowedSecretNames.add(storeContract.secrets.config_secret);
for (const [name, entry] of Object.entries(storeContract.secrets?.variables ?? {})) {
  if (entry.store !== "credential" || !entry.secret) continue;
  if (!storedByTarget || contract.secrets?.variables?.[name]) allowedSecretNames.add(entry.secret);
}

/** Name from a `valueFrom`: a Secrets Manager ARN ends in AWS's `-<6 random>` suffix, which is stripped. */
function secretNameOf(valueFrom) {
  if (typeof valueFrom !== "string") return null;
  const sm = /^arn:aws[a-z-]*:secretsmanager:[^:]*:[^:]*:secret:(.+)$/.exec(valueFrom);
  if (sm) {
    const withoutKey = sm[1].split(":")[0];
    return withoutKey.replace(/-[A-Za-z0-9]{6}$/, "");
  }
  const ssm = /^arn:aws[a-z-]*:ssm:[^:]*:[^:]*:parameter(\/.+)$/.exec(valueFrom);
  if (ssm) return `ssm:${ssm[1]}`;
  return null;
}

for (const [name, valueFrom] of secretRefs) {
  const secretName = secretNameOf(valueFrom);
  if (secretName === null) {
    fail(
      "valueFrom",
      `${name} has a valueFrom this check cannot parse (${valueFrom}) — refusing to treat an ` +
        `unrecognised reference as safe`
    );
    continue;
  }
  if (secretName.startsWith("ssm:")) {
    fail(
      "valueFrom",
      `${name} reads ${secretName} from SSM Parameter Store — ADR-025 moved configuration to ` +
        `Secrets Manager, and a lingering SSM reference means the render is mixing two schemes`
    );
    continue;
  }
  if (!allowedSecretNames.has(secretName)) {
    fail(
      "valueFrom",
      `CROSS-SERVICE READ: ${name} reads secret "${secretName}", which is not ${storeContract.service ?? service}'s own ` +
        `config secret nor a credential its contract names (allowed: ${[...allowedSecretNames].join(", ") || "none"})`
    );
  }
}

for (const [name, entry] of Object.entries(contract.secrets?.variables ?? {})) {
  if (entry.required && !declared.has(name)) {
    fail("missing", `${name} is required for ${service} but the rendered document does not set it`);
  }
}
for (const [name, entry] of Object.entries(contract.environment ?? {})) {
  if (entry.required && !declared.has(name)) {
    fail("missing", `${name} is required for ${service} but the rendered document does not set it`);
  }
}

const summary =
  `${service} (${targetEnv}, ${contract.kind}): ${environment.size} plaintext, ` +
  `${secretRefs.size} secret reference(s), ${prohibitions.reduce((n, [, l]) => n + l.length, 0)} prohibited name(s) checked`;

if (failures.length) {
  console.error(`✗ ${summary}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    `\n${failures.length} boundary violation(s). Nothing is registered. This check is not a ` +
      `formality to be relaxed — see ADR-002 and ADR-025 decision 5.`
  );
  process.exit(1);
}

console.log(`✓ ${summary} — no boundary violation`);
