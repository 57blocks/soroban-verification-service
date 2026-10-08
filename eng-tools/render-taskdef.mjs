#!/usr/bin/env node
/** Renders a service's ECS task definition: its family's newest ACTIVE revision with only image and secrets replaced. */
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
    "usage: render-taskdef.mjs --env <env> --service <name> --image <ref> [--descriptor @file] [--baseline @file]"
  );
  process.exit(2);
}

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

const contractPath = flag("contract") ?? `config/deploy/${targetEnv}/${service}.json`;
const contract = (() => {
  try {
    return JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    return die(`no contract at ${contractPath}`);
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


// The newest ACTIVE revision, not the running one: Terraform-minted changes reach tasks only through it.
const baseline =
  loadJson(flag("baseline"), "baseline") ??
  JSON.parse(aws(["ecs", "describe-task-definition", "--task-definition", family, "--query", "taskDefinition", "--output", "json"]));

const baselineContainer = baseline.containerDefinitions?.find((c) => c.name === service);

const baselineValueFrom = new Map(
  (baselineContainer?.secrets ?? []).map((s) => [s.name, s.valueFrom])
);

// ARNs carry the account id, so they are resolved here and never committed.

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
    // Reused from the baseline, not resolved: CI holds no grant on a credential secret, not even DescribeSecret.
    const existing = baselineValueFrom.get(name);
    if (!existing) {
      if (entry.required) {
        missing.push(
          `${name} is a required credential, but its baseline ${family}:${baseline.revision} does not reference it — ` +
            `adding it is the job of whoever owns the secret, not CI's`
        );
      }
      continue;
    }
    secrets.push({ name, valueFrom: existing });
    continue;
  }
  // Only keys sync-secrets writes (a recorded value, a source path, or `generate:`); anything else would dangle.
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

const plaintext = Object.entries(contract.environment ?? {});
if (plaintext.length) {
  die(
    `${service}'s contract still carries ${plaintext.length} plaintext environment variable(s) ` +
      `(${plaintext.map(([n]) => n).join(", ")}) — regenerate with \`pnpm run generate:deploy-env\``
  );
}

const container = baseline.containerDefinitions?.find((c) => c.name === service);
if (!container) {
  die(`the baseline ${family}:${baseline.revision} has no container named "${service}" (has: ${(baseline.containerDefinitions ?? []).map((c) => c.name).join(", ") || "none"})`);
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
console.error(`✓ ${service} (${targetEnv}) rendered from ${family}:${baseline.revision} — ${counts}, 0 plaintext`);
