#!/usr/bin/env node
/** Emits `config/deploy/<env>/<service>.json`, the flat per-service artifact, from `config/env-manifest.yaml`. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, resolveManifest } from "./env-manifest.mjs";

export const OUTPUT_DIR = "config/deploy";

const ENV_BLOCK_INJECTS = new Set([
  "ecs-environment",
  "batch-job-definition",
  "batch-container-environment",
]);

const isRequired = (entry) => entry.required === true || entry.required === "yes";

export const configSecretName = (targetEnv, service) => `scvs/${targetEnv}/${service}/config`;

const defaultInjectFor = (kind) =>
  kind === "batch-job-definition" ? "batch-job-definition" : "ecs-secrets";

const sourceOf = (entry) => entry.source ?? "literal";

function describe(entry, targetEnv, name) {
  const source = sourceOf(entry);
  const out = { required: isRequired(entry), fail: entry.fail ?? "n/a", source };
  if (entry.required_when) out.required_when = entry.required_when;

  if (source === "secret") {
    const rawName = entry.secret_ref?.name;
    const resolvedName =
      rawName && typeof rawName === "object" ? rawName[targetEnv] : rawName;
    if (resolvedName) {
      out.secret = resolvedName;
      if (entry.secret_ref.json_key) out.json_key = entry.secret_ref.json_key;
    } else if (rawName && typeof rawName === "object" && isRequired(entry)) {
      throw new Error(
        `${name}: secret_ref.name has no entry for target environment "${targetEnv}" ` +
          `(required: true) — add one to config/env-manifest.yaml`
      );
    }
    return out;
  }

  const recorded = entry.envs?.[targetEnv];

  if (source === "literal" || source === "image-build") {
    if (source === "image-build") {
      out.note = "the image supplies this; set it only to point somewhere else";
    }
    if (recorded !== undefined) out.value = String(recorded);
    else if (entry.value_ref) {
      out.value_ref = entry.value_ref;
    } else if (entry.default !== undefined && entry.default !== null) {
      out.default = String(entry.default);
      out.note = "optional — the service supplies this default; set it only to override";
    }
    return out;
  }

  // sync-secrets and render-taskdef branch on `generate` and never read the manifest.
  if (entry.generate) out.generate = entry.generate;
  if (entry.value_from_output) out.value_from_output = entry.value_from_output;
  if (entry.terraform) out.terraform_output = entry.terraform;
  if (entry.resource) out.resource = entry.resource.replaceAll("<env>", targetEnv);
  if (recorded !== undefined) {
    out.value = String(recorded);
    out.value_is_authoritative = false;
  }
  return out;
}

export function buildArtifacts(manifest, environments) {
  const resolved = resolveManifest(manifest);
  const envs = environments?.length ? environments : (manifest.meta?.environments ?? ["dev"]);
  const artifacts = new Map();

  for (const targetEnv of envs) {
    for (const [service, svc] of resolved.services) {
      const { allowed, forbidden } = resolved.effective.get(service);

      const environment = {};
      const secrets = {};
      const buildArgs = {};
      const perInvocation = [];

      const neverDeployed = [];

      for (const [name, entry] of [...allowed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const inject = entry.inject ?? defaultInjectFor(svc.kind);
        if (entry.deploy === "never") {
          neverDeployed.push(name);
        } else if (inject === "batch-submit-job" || inject === "ecs-run-task-override") {
          perInvocation.push(name);
        } else if (inject === "ecs-secrets") {
          const d = describe(entry, targetEnv, name);
          const tier = entry.tier ?? "knob";
          d.store = tier === "secret" ? "credential" : "config";
          if (d.store === "config") d.json_key = name;
          secrets[name] = d;
        } else if (inject === "docker-build-arg") {
          buildArgs[name] = describe(entry, targetEnv, name);
        } else if (ENV_BLOCK_INJECTS.has(inject)) {
          environment[name] = describe(entry, targetEnv, name);
        }
      }

      const invariants = Object.entries(manifest.groups ?? {})
        .filter(([groupName, group]) => {
          const match = /^identical-across\(([^)]*)\)$/.exec(group.invariant ?? "");
          return match && (svc.inherits ?? []).includes(groupName);
        })
        .map(([groupName, group]) => ({
          group: groupName,
          identical_across: /^identical-across\(([^)]*)\)$/
            .exec(group.invariant)[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          variables: Object.keys(manifest.groups[groupName].variables ?? {}).filter(
            (n) => allowed.has(n)
          ),
        }));

      const artifact = {
        $generated:
          "from config/env-manifest.yaml by eng-tools/generate-deploy-env.mjs — do not edit; " +
          "run `pnpm run generate:deploy-env`",
        $contract: "docs/design/aws-deployment.md §6 · ADR-012 · ADR-025",
        target_env: targetEnv,
        service,
        kind: svc.kind ?? null,
        exposure: svc.exposure ?? null,
        environment,
        ...(Object.keys(secrets).length
          ? {
              secrets: {
                $note:
                  "Every deployed variable arrives via ECS `secrets`/`valueFrom` (ADR-025). `store` " +
                  "says which secret: `config` is `" +
                  configSecretName(targetEnv, service) +
                  "`, written by CI on every deploy from `json_key`; `credential` names its own " +
                  "pre-existing secret in `secret`, which CI has no grant to write. Keeping the two " +
                  "apart is load-bearing — a grant to read a timeout must not read a password.",
                config_secret: configSecretName(targetEnv, service),
                variables: secrets,
              },
            }
          : {}),
        ...(Object.keys(buildArgs).length ? { build_args: buildArgs } : {}),
        ...(perInvocation.length
          ? {
              per_invocation: {
                $note:
                  "supplied per invocation by whatever starts this — another service's submit call, or the " +
                  "pipeline's `run-task` override. Must NOT appear in the task or job definition: a value " +
                  "baked there is a stale spec that will be used.",
                variables: perInvocation.sort(),
              },
            }
          : {}),
        forbidden: {
          $note:
            "must never be set for this service. For the builder this is ADR-002's trust boundary and " +
            "is normative for the Batch job definition, which CI cannot inspect.",
          variables: [...forbidden].sort(),
        },
        ...(neverDeployed.length
          ? {
              not_in_deployment: {
                $note:
                  "read by the code and valid in local development, but must not be set in a deployed " +
                  "environment — see the manifest entry for why",
                variables: neverDeployed.sort(),
              },
            }
          : {}),
        ...(invariants.length ? { invariants } : {}),
      };

      artifacts.set(
        `${OUTPUT_DIR}/${targetEnv}/${service}.json`,
        `${JSON.stringify(artifact, null, 2)}\n`
      );
    }
  }
  return artifacts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const environments = process.argv.reduce(
    (acc, arg, i) => (arg === "--env" ? [...acc, process.argv[i + 1]] : acc),
    [],
  );
  if (environments.some((name) => !name || name.startsWith("--"))) {
    console.error("--env takes an environment name, e.g. --env dev --env staging");
    process.exit(1);
  }
  const artifacts = buildArtifacts(loadManifest(root), environments);
  const checkOnly = process.argv.includes("--check");
  const stale = [];

  for (const [rel, content] of artifacts) {
    const path = join(root, rel);
    if (checkOnly) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (current !== content) stale.push(rel + (current === null ? " (missing)" : " (stale)"));
      continue;
    }
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(path, content);
  }

  if (checkOnly) {
    if (!stale.length) {
      console.log(`✓ ${artifacts.size} deploy artifact(s) up to date with the manifest`);
      process.exit(0);
    }
    console.error(
      `${stale.length} deploy artifact(s) out of date — run \`pnpm run generate:deploy-env\`:\n` +
        stale.map((s) => `  ${s}`).join("\n")
    );
    process.exit(1);
  }
  console.log(`wrote ${artifacts.size} artifact(s) under ${OUTPUT_DIR}/`);
}
