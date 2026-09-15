#!/usr/bin/env node
/**
 * Renders a service's ECS task definition from the deployment contract.
 *
 *   node eng-tools/render-taskdef.mjs --env dev --service query-svc \
 *     --image <digest-or-ref> [--descriptor @file] [--contract @file] [--baseline @file] > /tmp/td.json
 *
 * ADR-025's write half. It takes the RUNNING task definition as its baseline and replaces only the
 * two things this repository owns — the container image, and every environment variable — leaving
 * everything else byte-for-byte.
 *
 * **Baseline-and-replace, not render-from-scratch, and that is the load-bearing decision here.** A
 * task definition carries cpu, memory, the port mapping, the health check command, the log group, the
 * runtime platform, and two role ARNs. None of that is configuration; it is infrastructure Terraform
 * owns, and no descriptor field carries it. Generating it here would be a second implementation of
 * someone else's contract, drifting silently — the failure ADR-006 exists to prevent, and the reason
 * ADR-025 scopes this repository to *configuration* rather than to the whole document.
 *
 * So the split is mechanical: fields this repo owns are overwritten, every other field is passed
 * through untouched, and a field appearing in neither list is a hard error rather than a silent drop.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const targetEnv = flag("env", "dev");
const service = flag("service");
const image = flag("image");

if (!service || !image) {
  console.error(
    "usage: render-taskdef.mjs --env <env> --service <name> --image <ref> [--descriptor @file] [--contract @file] [--baseline @file]"
  );
  process.exit(2);
}

// An unresolved shell variable produces a reference that registers cleanly and then fails at task
// start with an ECR pull error, several layers from the cause — which is exactly what a caller
// composing the registry hostname from a stripped `account_id` field would have produced. Cheaper to
// reject the shape here than to debug it from a rollout.
if (!/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/\S+$/.test(image)) {
  console.error(
    `::error::--image "${image}" is not an ECR reference ` +
      `(<account>.dkr.ecr.<region>.amazonaws.com/<repo>[:tag|@sha256:...])`
  );
  process.exit(1);
}

const die = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

const aws = (argv) => execFileSync("aws", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const loadJson = (raw, what) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw);
  } catch (error) {
    die(`--${what} is not valid JSON: ${error.message}`);
  }
};

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

const contract =
  loadJson(flag("contract"), "contract") ??
  (() => {
    try {
      return JSON.parse(readFileSync(`config/deploy/${targetEnv}/${service}.json`, "utf8"));
    } catch {
      return die(`no contract at config/deploy/${targetEnv}/${service}.json`);
    }
  })();

if (contract.kind !== "ecs-service" && contract.kind !== "ecs-task") {
  die(`${service} is kind: ${contract.kind} — this renders ECS task definitions only (ADR-025 keeps Batch on plaintext)`);
}

const descriptor =
  loadJson(flag("descriptor"), "descriptor") ??
  loadJson(process.env.CI_DESCRIPTOR_JSON, "descriptor") ??
  loadJson(aws(["ssm", "get-parameter", "--name", `/scvs/${targetEnv}/ci/descriptor`, "--query", "Parameter.Value", "--output", "text"]), "descriptor");

const family = descriptor?.task_definition_families?.[service.replaceAll("-", "_")];
if (!family) die(`the ${targetEnv} descriptor names no task_definition_families entry for ${service}`);


// The running definition, not the family's newest: the newest could be one nothing adopted, and this
// tool's whole premise is that it edits what is actually serving traffic.
const baseline =
  loadJson(flag("baseline"), "baseline") ??
  JSON.parse(aws(["ecs", "describe-task-definition", "--task-definition", family, "--query", "taskDefinition", "--output", "json"]));

const baselineContainer = baseline.containerDefinitions?.find((c) => c.name === service);

/** What the running definition already uses for a variable, if anything. */
const baselineValueFrom = new Map(
  (baselineContainer?.secrets ?? []).map((s) => [s.name, s.valueFrom])
);

// ── Resolve every variable's valueFrom ──────────────────────────────────────────────────────────
// A secret's ARN carries the account id and the six random characters AWS appends, so it is resolved
// here and never committed (ADR-012 `decided: Q2`). One lookup per distinct secret, not per variable.

const secretArns = new Map();
function arnOf(secretName) {
  if (secretArns.has(secretName)) return secretArns.get(secretName);
  let arn;
  try {
    arn = aws(["secretsmanager", "describe-secret", "--secret-id", secretName, "--query", "ARN", "--output", "text"]).trim();
  } catch {
    die(
      `secret "${secretName}" does not exist or is unreadable in ${targetEnv}. ` +
        `For a config secret, run \`node eng-tools/sync-secrets.mjs --env ${targetEnv} --service ${service}\` first`
    );
  }
  if (!arn || arn === "None") die(`secret "${secretName}" resolved to no ARN`);
  secretArns.set(secretName, arn);
  return arn;
}

const configSecret = contract.secrets?.config_secret;
const secrets = [];
const missing = [];

for (const [name, entry] of Object.entries(contract.secrets?.variables ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
  if (entry.store === "credential") {
    // Carried over from the running definition rather than resolved. CI holds NO grant on a
    // credential secret — not even DescribeSecret — which is ADR-016's blast-radius argument working
    // as intended, and it is why resolving the ARN here failed the first real deploy. The ARN is
    // already in the baseline, put there by whoever provisioned the secret, so reusing it needs no
    // grant and cannot drift from what the service currently reads.
    const existing = baselineValueFrom.get(name);
    if (!existing) {
      if (entry.required) {
        missing.push(
          `${name} is a required credential, but the running ${family} does not reference it — ` +
            `adding it is the job of whoever owns the secret, not CI's`
        );
      }
      continue;
    }
    secrets.push({ name, valueFrom: existing });
    continue;
  }
  // store: config — one key per variable in the service's own config secret, and ONLY for a variable
  // sync-secrets actually writes. The two must agree or the reference dangles; what decides is a
  // recorded value, never `source:` (see the note there).
  // `generate:` is a third way for the config secret to hold a key: sync-secrets minted it rather than
  // copying a recorded value, so there is nothing in the contract to point at — only a key that exists.
  if (entry.value === undefined && !entry.value_from_output && !entry.generate) {
    if (entry.required) {
      missing.push(`${name} is required but the contract records neither a value nor a source path`);
    }
    continue;
  }
  if (!configSecret) die(`${service}'s contract has config-store variables but no secrets.config_secret`);
  secrets.push({ name, valueFrom: `${arnOf(configSecret)}:${entry.json_key ?? name}::` });
}

if (missing.length) die(`cannot render ${service}: ${missing.join("; ")}`);

// ECS resolves every `valueFrom` before the container starts, so a key referenced here but absent
// from the secret is a task that cannot boot — surfacing minutes later as a rollout failure with the
// cause several layers down. Reading the secret back turns that into a render-time error naming the
// keys. It caught seven on the first real render, before anything was registered.
if (configSecret && secrets.some((s) => s.valueFrom.includes(`${configSecret}-`))) {
  let stored;
  try {
    stored = JSON.parse(aws(["secretsmanager", "get-secret-value", "--secret-id", configSecret, "--query", "SecretString", "--output", "text"]));
  } catch (error) {
    die(`cannot read ${configSecret} to verify the keys this render references: ${error.message}`);
  }
  const dangling = secrets
    .filter((s) => s.valueFrom.includes(`${configSecret}-`))
    .map((s) => s.valueFrom.split(":").at(-3))
    .filter((key) => !(key in stored));
  if (dangling.length) {
    die(
      `${dangling.length} key(s) referenced but absent from ${configSecret}: ${dangling.join(", ")}. ` +
        `Run \`node eng-tools/sync-secrets.mjs --env ${targetEnv} --service ${service}\` first — a task ` +
        `whose valueFrom cannot resolve fails to start`
    );
  }
}

// Every variable now arrives by reference. A leftover plaintext entry means the contract and this
// renderer disagree, which is worth failing over rather than shipping a half-migrated definition.
const plaintext = Object.entries(contract.environment ?? {});
if (plaintext.length) {
  die(
    `${service}'s contract still carries ${plaintext.length} plaintext environment variable(s) ` +
      `(${plaintext.map(([n]) => n).join(", ")}) — regenerate with \`pnpm run generate:deploy-env\``
  );
}

// ── Compose ─────────────────────────────────────────────────────────────────────────────────────

const container = baseline.containerDefinitions?.find((c) => c.name === service);
if (!container) {
  die(`the running ${family} has no container named "${service}" (has: ${(baseline.containerDefinitions ?? []).map((c) => c.name).join(", ") || "none"})`);
}

// register-task-definition rejects the read-only fields describe-task-definition returns.
const READ_ONLY = new Set([
  "taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
  "registeredAt", "registeredBy", "deregisteredAt",
]);

const rendered = Object.fromEntries(Object.entries(baseline).filter(([k]) => !READ_ONLY.has(k)));

rendered.containerDefinitions = baseline.containerDefinitions.map((c) =>
  c.name !== service ? c : { ...c, image, environment: [], secrets }
);

process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);

const counts = `${secrets.length} secret reference(s), ${secretArns.size} secret(s)`;
console.error(`✓ ${service} (${targetEnv}) rendered from running ${family}:${baseline.revision} — ${counts}, 0 plaintext`);
