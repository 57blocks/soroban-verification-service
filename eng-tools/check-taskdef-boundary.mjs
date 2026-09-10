#!/usr/bin/env node
/**
 * Asserts a rendered task/job definition against the trust boundary before anything registers it.
 *
 *   node eng-tools/check-taskdef-boundary.mjs --env dev --service builder /tmp/td.json
 *
 * **This check is load-bearing, and it exists because ADR-025 removed the thing that used to do its
 * job.** Until then the builder's `forbidden` list was enforced by topology: the Batch job definition
 * was Terraform's, in another repository, so CI *could not* put a database credential in the sandbox
 * even by accident. `config/deploy/README.md` said so outright — "CI cannot check it … the one place
 * in this contract that needs a human on your side". ADR-025 makes CI the writer, which turns that
 * structural guarantee into a procedural one unless something mechanical replaces it. This is that
 * replacement, and ADR-025 decision 5 makes shipping it a condition of the change rather than a
 * follow-up.
 *
 * So: it fails closed. An input it cannot parse, a service it has no contract for, a shape it does not
 * recognise — all are failures, never skips. A boundary check that silently passes when confused is
 * worse than none, because the deploy goes green either way and only one of those states is true.
 *
 * What it asserts, per ADR-002 and the service's own `config/deploy/<env>/<service>.json`:
 *
 *   1  no `forbidden` variable appears, in `environment`, `secrets`, or a Batch container override
 *   2  no `per_invocation` variable is baked in — those arrive at SubmitJob time, and a baked value
 *      is a stale job spec that WILL be used
 *   3  no `not_in_deployment` variable appears (DATABASE_URL embeds a password in a URL)
 *   4  a Batch job definition carries no `jobRoleArn` — the sandbox holds no business credentials
 *   5  every `secrets[].valueFrom` points at a secret this service is allowed to read: its own
 *      config secret, or a credential secret the artifact names. Not another service's.
 *   6  every variable the artifact requires is actually present in the rendered document
 *
 * (5) is the one that is easy to get wrong and invisible when wrong: a rendered document that reads
 * orchestrator-svc's config secret into query-svc's task would start cleanly and serve wrong data.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
    "usage: check-taskdef-boundary.mjs --env <env> --service <name> <rendered-taskdef.json>"
  );
  process.exit(2);
}

const ROOT = process.cwd();
const contractPath = join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
if (!existsSync(contractPath)) {
  // Fail closed: no contract means nothing to check against, which is not the same as nothing to find.
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

// ── Flatten the rendered document ───────────────────────────────────────────────────────────────
// ECS puts these on each containerDefinition; Batch puts them on containerProperties (and, for a
// multi-node job, on each node range's container). Walking every shape rather than branching on
// `kind` is deliberate: an unrecognised nesting must not become an unchecked one.

const environment = new Map(); // name -> value
const secretRefs = new Map(); // name -> valueFrom
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
// `ecsProperties` is the multi-container Batch shape, and it is what the builder actually uses —
// deploy-builder.yml registers a `materialise` and a `runner` container in one task. Missing it made
// this check unusable for the one job definition ADR-002 is most about.
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

// ── 1–3: prohibitions ───────────────────────────────────────────────────────────────────────────

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

// ── 4: the SANDBOX holds no job role ────────────────────────────────────────────────────────────
// ADR-002, and aws-deployment.md §5.1 calls the IAM asymmetry load-bearing. `jobRoleArn` is what
// would give the sandbox business credentials; the execution role (ECR pull + logs) is a different
// field and is legitimate.
//
// Builder-only, not every Batch job definition. The composer is also Batch but is the *trusted*
// fleet — no submitted input reaches it, and ADR-017 requires it to hold `ecr:PutImage` — so a
// `jobRoleArn` there is the design. Asserting both would fail every composer deploy on its own
// design. Its `forbidden` list still applies in full; only this rule is scoped.
const SANDBOX_SERVICES = new Set(["builder"]);

if (contract.kind === "batch-job-definition" && SANDBOX_SERVICES.has(service)) {
  // `ecsProperties` carries taskRoleArn/executionRoleArn one level up from the containers, so the
  // per-container loop below would not see a role granted there.
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
  // A sandbox that reads a secret needs secretsmanager:GetSecretValue on its execution role, which
  // is exactly the grant ADR-002 keeps it from having. ADR-025 decision 1 states the exception:
  // Batch keeps its variables plaintext.
  if (secretRefs.size) {
    fail(
      "batch-secrets",
      `TRUST BOUNDARY: ${service} is a Batch job definition and must not reference secrets ` +
        `(${[...secretRefs.keys()].join(", ")}) — reading one requires a grant its execution role ` +
        `does not and must not have (ADR-002, ADR-025 decision 1)`
    );
  }
}

// ── 5: every secret reference points somewhere this service may read ────────────────────────────
// The config secret's ARN is resolved at deploy time and carries an AWS-generated suffix, so this
// matches on the secret NAME embedded in the ARN rather than on the ARN itself.

const allowedSecretNames = new Set();
if (contract.secrets?.config_secret) allowedSecretNames.add(contract.secrets.config_secret);
for (const entry of Object.values(contract.secrets?.variables ?? {})) {
  if (entry.store === "credential" && entry.secret) allowedSecretNames.add(entry.secret);
}

/**
 * Pulls the secret/parameter name out of a `valueFrom`.
 *
 * Secrets Manager: arn:aws:secretsmanager:<region>:<acct>:secret:<name>-<6 random>[:key:stage:ver]
 * The six-character suffix is AWS's, not ours, so it is stripped — but only when it looks like one,
 * because a name may legitimately contain a hyphen (`sv-dev-rds-master-verify`).
 */
function secretNameOf(valueFrom) {
  if (typeof valueFrom !== "string") return null;
  const sm = /^arn:aws[a-z-]*:secretsmanager:[^:]*:[^:]*:secret:(.+)$/.exec(valueFrom);
  if (sm) {
    // Trailing `:json_key:version-stage:version-id` — drop anything after the name segment.
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
      `CROSS-SERVICE READ: ${name} reads secret "${secretName}", which is not ${service}'s own ` +
        `config secret nor a credential its contract names (allowed: ${[...allowedSecretNames].join(", ") || "none"})`
    );
  }
}

// ── 6: everything required is actually present ──────────────────────────────────────────────────
// A rendered document that silently drops a required variable is the `fail: silent` class this whole
// contract exists to make loud — it would boot, pass a health check, and behave wrongly.

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

// ── Report ──────────────────────────────────────────────────────────────────────────────────────

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
