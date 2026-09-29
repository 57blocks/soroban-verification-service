#!/usr/bin/env node
/** Renders the one-off migration task definition from the target service's running one, keeping only what the db-migrate contract allows. */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const die = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

const target = flag("target");
const image = flag("image");
const family = flag("family");
const executionRole = flag("execution-role");
const baselinePath = flag("baseline");
const contractPath = flag("contract");

if (!target || !image || !family || !executionRole || !baselinePath || !contractPath) {
  console.error(
    "usage: render-migrate-taskdef.mjs --target <service> --image <repo@sha256:...> --family <name> " +
      "--execution-role <arn> --baseline <describe-task-definition.json> --contract <db-migrate.json>"
  );
  process.exit(2);
}

if (!/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[^@:\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
  die(`--image "${image}" is not an ECR reference pinned by digest (<registry>/<repo>@sha256:<64 hex>)`);
}
if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/\S+$/.test(executionRole)) {
  die(`--execution-role "${executionRole}" is not an IAM role ARN`);
}

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return die(`${what} at ${path} is not readable JSON: ${error.message}`);
  }
};

const contract = readJson(contractPath, "the db-migrate contract");
if (contract.kind !== "ecs-task" || contract.secrets?.stores_of !== "target") {
  die(`${contractPath} is not an ecs-task contract whose values live in the target's stores (secrets.stores_of: target)`);
}

const described = readJson(baselinePath, "the target task definition");
const baseline = described.taskDefinition ?? described;
const containers = baseline.containerDefinitions ?? [];
if (containers.length !== 1 || containers[0].name !== target) {
  die(
    `${baseline.taskDefinitionArn ?? baselinePath} must hold exactly one container named ${target}; ` +
      `found ${containers.map((c) => c.name).join(", ") || "none"}`
  );
}
const [source] = containers;

const allowed = new Set([
  ...Object.keys(contract.secrets?.variables ?? {}),
  ...Object.keys(contract.environment ?? {}),
]);
for (const name of contract.per_invocation?.variables ?? []) allowed.delete(name);

const keep = (entries) => (entries ?? []).filter((entry) => allowed.has(entry.name));
const secrets = keep(source.secrets);
const environment = keep(source.environment);
const dropped = [...(source.secrets ?? []), ...(source.environment ?? [])]
  .map((entry) => entry.name)
  .filter((name) => !allowed.has(name))
  .sort();

if (!source.logConfiguration) {
  die(`${target}'s container has no logConfiguration; the migration's output would be unreadable`);
}

const rendered = {
  family,
  executionRoleArn: executionRole,
  networkMode: baseline.networkMode,
  requiresCompatibilities: baseline.requiresCompatibilities,
  cpu: baseline.cpu,
  memory: baseline.memory,
  ...(baseline.runtimePlatform ? { runtimePlatform: baseline.runtimePlatform } : {}),
  containerDefinitions: [
    {
      name: target,
      image,
      essential: true,
      secrets,
      environment,
      logConfiguration: source.logConfiguration,
    },
  ],
};

console.error(
  `${family}: kept ${secrets.length + environment.length} of ${secrets.length + environment.length + dropped.length} ` +
    `variable(s) from ${baseline.taskDefinitionArn ?? target}; dropped ${dropped.join(", ") || "none"}`
);
process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
