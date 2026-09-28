import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ExecutionMode = "AUTO" | "AUTO-SLOW" | "PERF" | "BROWSER" | "MANUAL";
export type AutoScope = "auto" | "slow" | "all";

function str(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function flag(name: string): boolean {
  return str(name) === "1" || str(name)?.toLowerCase() === "true";
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface E2eEnv {
  readonly enabled: boolean;

  readonly runId: string;

  readonly verifyUrl?: string;
  readonly queryUrl?: string;
  readonly webUrl?: string;
  readonly resultRoot?: string;

  readonly network: "mainnet" | "testnet";

  readonly allowPerf: boolean;
  readonly autoScope: AutoScope;
  readonly allowBrowser: boolean;
  readonly strictTrd: boolean;

  readonly jobTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly requestTimeoutMs: number;
}

const jobTimeoutMs = Number(str("SCVS_E2E_JOB_TIMEOUT_MS") ?? 20 * 60_000);
const pollIntervalMs = Number(str("SCVS_E2E_POLL_INTERVAL_MS") ?? 3_000);
const requestTimeoutMs = Number(str("SCVS_E2E_REQUEST_TIMEOUT_MS") ?? 30_000);

const network = (str("SCVS_E2E_NETWORK") ?? "testnet") as "mainnet" | "testnet";
if (network !== "mainnet" && network !== "testnet") {
  throw new Error(
    `SCVS_E2E_NETWORK must be "mainnet" or "testnet"; received ${JSON.stringify(network)}.`
  );
}

const autoScope = str("SCVS_E2E_AUTO_SCOPE") ?? "auto";
if (autoScope !== "auto" && autoScope !== "slow" && autoScope !== "all") {
  throw new Error(
    `SCVS_E2E_AUTO_SCOPE must be "auto", "slow", or "all"; received ${JSON.stringify(autoScope)}.`,
  );
}

export const env: E2eEnv = Object.freeze({
  enabled: flag("SCVS_E2E"),
  runId: str("SCVS_E2E_RUN_ID") ?? randomUUID(),
  verifyUrl: str("SCVS_E2E_VERIFY_URL") && trimTrailingSlash(str("SCVS_E2E_VERIFY_URL")!),
  queryUrl: str("SCVS_E2E_QUERY_URL") && trimTrailingSlash(str("SCVS_E2E_QUERY_URL")!),
  webUrl: str("SCVS_E2E_WEB_URL") && trimTrailingSlash(str("SCVS_E2E_WEB_URL")!),
  resultRoot: str("SCVS_E2E_RESULT_ROOT") && trimTrailingSlash(str("SCVS_E2E_RESULT_ROOT")!),
  network,
  allowPerf: flag("SCVS_E2E_ALLOW_PERF"),
  autoScope,
  allowBrowser: flag("SCVS_E2E_ALLOW_BROWSER"),
  strictTrd: flag("SCVS_E2E_STRICT_TRD"),
  jobTimeoutMs,
  pollIntervalMs,
  requestTimeoutMs,
});

const deployEnv = str("SCVS_E2E_ENV");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface DeclaredVariable {
  source?: string;
  value?: unknown;
  default?: unknown;
  note?: string;
  value_is_authoritative?: boolean;
}

interface DeployArtifact {
  target_env?: string;
  environment?: Record<string, DeclaredVariable | undefined>;
  ssm_parameters?: { variables?: Record<string, DeclaredVariable | undefined> };
  secrets?: { variables?: Record<string, DeclaredVariable | undefined> };
}

function declaredVariable(
  artifact: DeployArtifact,
  name: string
): DeclaredVariable | undefined {
  return (
    artifact.environment?.[name] ??
    artifact.ssm_parameters?.variables?.[name] ??
    artifact.secrets?.variables?.[name]
  );
}

function loadDeployArtifact(
  service = "builder"
): { path: string; artifact: DeployArtifact } | undefined {
  if (!deployEnv) return undefined;

  const path = join(repoRoot, "config", "deploy", deployEnv, `${service}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `SCVS_E2E_ENV=${deployEnv} but ${path} does not exist. Either name an environment this ` +
        `repository deploys (config/deploy/*/${service}.json), or leave SCVS_E2E_ENV unset and supply ` +
        `live-config evidence for the deployment's declared configuration.`
    );
  }

  let artifact: DeployArtifact;
  try {
    artifact = JSON.parse(readFileSync(path, "utf8")) as DeployArtifact;
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${(error as Error).message}). It is generated — run ` +
        `\`pnpm run generate:deploy-env\` rather than editing it.`
    );
  }

  if (artifact.target_env && artifact.target_env !== deployEnv) {
    throw new Error(
      `${path} declares target_env=${artifact.target_env} but SCVS_E2E_ENV=${deployEnv}. ` +
        `Re-run \`pnpm run generate:deploy-env\`; a 📐 case must not read one environment's bounds ` +
        `while pointed at another.`
    );
  }

  return { path, artifact };
}

const deployArtifact = loadDeployArtifact("builder");
const orchestratorDeployArtifact = loadDeployArtifact("orchestrator-svc");

function deployLiteralNumber(
  deploy: { path: string; artifact: DeployArtifact } | undefined,
  variable: string,
): { value?: number; describe: string } {
  if (!deploy) {
    return {
      describe: `${variable}: unavailable — SCVS_E2E_ENV is unset, so no deployment descriptor is bound`,
    };
  }

  const declared = declaredVariable(deploy.artifact, variable);
  if (!declared) return { describe: `${deploy.path} declares no ${variable}` };
  if (declared.source !== "literal") {
    return {
      describe: `${deploy.path} declares ${variable} with source=${declared.source ?? "(none)"}`,
    };
  }

  const raw = declared.value ?? declared.default;
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return { describe: `${deploy.path} states ${variable} as ${JSON.stringify(raw)}, not a positive number` };
  }
  return { value, describe: `${variable}=${value} (${deploy.path})` };
}

function callerSuppliedDeploymentNumber(
  environmentVariable: string,
  parameter: string,
): { value?: number; describe: string } {
  const raw = str(environmentVariable);
  if (!raw) return { describe: `${parameter}: unavailable — ${environmentVariable} is unset` };

  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      `${environmentVariable} must be a positive whole number supplied from the deployment contract; received ${JSON.stringify(raw)}.`,
    );
  }

  return {
    value: Number(raw),
    describe: `${parameter}=${raw} (caller-supplied deployment contract ${environmentVariable})`,
  };
}

function deploymentNumber(
  deploy: { path: string; artifact: DeployArtifact } | undefined,
  variable: string,
  environmentVariable: string,
): { value?: number; describe: string } {
  const supplied = callerSuppliedDeploymentNumber(environmentVariable, variable);
  if (deploy && supplied.value !== undefined) {
    throw new Error(
      `${environmentVariable} and SCVS_E2E_ENV are both set. Supply deployment evidence through one source only.`,
    );
  }
  return supplied.value === undefined ? deployLiteralNumber(deploy, variable) : supplied;
}

const retryParameters = Object.freeze({
  interval: deploymentNumber(
    orchestratorDeployArtifact,
    "SCVS_JOB_RETRY_INTERVAL_MS",
    "SCVS_E2E_JOB_RETRY_INTERVAL_MS",
  ),
  maxAttempts: deploymentNumber(
    orchestratorDeployArtifact,
    "SCVS_MAX_JOB_RETRY_ATTEMPTS",
    "SCVS_E2E_MAX_JOB_RETRY_ATTEMPTS",
  ),
});

export const retryPolicyProvenance = Object.freeze({
  interval: retryParameters.interval.describe,
  maxAttempts: retryParameters.maxAttempts.describe,
});

function builderArchiveBound(variable: string): { value?: number; blocked?: string } {
  if (!deployArtifact) return {};

  const declared = declaredVariable(deployArtifact.artifact, variable);
  if (!declared) {
    return {
      blocked: `${deployArtifact.path} declares no ${variable}`,
    };
  }
  if (declared.source !== "literal") {
    return {
      blocked:
        `${deployArtifact.path} declares ${variable} with source=${declared.source ?? "(none)"}, ` +
        `so its effective value is not in the artefact`,
    };
  }

  const raw = declared.value ?? declared.default;
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return {
      blocked:
        `${deployArtifact.path} states ${variable} as ${JSON.stringify(raw)}, which is not a positive number`,
    };
  }
  return { value };
}

const ARCHIVE_BOUND_ENV_NAMES = [
  "SCVS_E2E_LIMIT_TAR_ENTRIES",
  "SCVS_E2E_LIMIT_UNCOMPRESSED_BYTES",
  "SCVS_E2E_LIMIT_ARCHIVE_BYTES",
] as const;

for (const name of ARCHIVE_BOUND_ENV_NAMES) {
  if (str(name)) {
    throw new Error(
      `${name} is no longer read. An archive bound must come from the deployment: either set ` +
        `SCVS_E2E_ENV=<dev|staging> so the harness reads config/deploy/<env>/builder.json, or supply ` +
        `live-config evidence for a deployment this repository does not manage. The accepted sources ` +
        `are listed under F-ADV-TAR's limits_from in test/fixtures/e2e/registry.yaml.`
    );
  }
}

function archiveBound(
  variable: string,
  parameter: string,
  environmentVariable: string,
): { value?: number; describe: string } {
  const supplied = callerSuppliedDeploymentNumber(environmentVariable, parameter);
  if (deployArtifact && supplied.value !== undefined) {
    throw new Error(
      `${environmentVariable} and SCVS_E2E_ENV are both set. Supply deployment evidence through one source only.`,
    );
  }
  if (supplied.value !== undefined) return supplied;

  if (!deployEnv) {
    return { describe: `${parameter}: unavailable — ${supplied.describe}` };
  }

  const bound = builderArchiveBound(variable);
  if (bound.value !== undefined) {
    return {
      value: bound.value,
      describe: `${parameter}=${bound.value} (config/deploy/${deployEnv}/builder.json ${variable})`,
    };
  }
  return { describe: `${parameter}: unavailable — ${bound.blocked}` };
}

const archiveBounds = Object.freeze({
  limitTarEntries: archiveBound(
    "SCVS_MAX_SOURCE_ARCHIVE_ENTRIES",
    "LIMIT_TAR_ENTRIES",
    "SCVS_E2E_ARCHIVE_MAX_ENTRIES",
  ),
  limitUncompressedBytes: archiveBound(
    "SCVS_MAX_SOURCE_ARCHIVE_UNCOMPRESSED_BYTES",
    "LIMIT_UNCOMPRESSED_BYTES",
    "SCVS_E2E_ARCHIVE_MAX_UNCOMPRESSED_BYTES",
  ),
  limitArchiveBytes: archiveBound(
    "SCVS_MAX_SOURCE_ARCHIVE_BYTES",
    "LIMIT_ARCHIVE_BYTES",
    "SCVS_E2E_ARCHIVE_MAX_BYTES",
  ),
});

export const archiveLimitProvenance: Readonly<Record<keyof typeof archiveBounds, string>> =
  Object.freeze({
    limitTarEntries: archiveBounds.limitTarEntries.describe,
    limitUncompressedBytes: archiveBounds.limitUncompressedBytes.describe,
    limitArchiveBytes: archiveBounds.limitArchiveBytes.describe,
  });

export const deploymentParameters = Object.freeze({
  limitTarEntries: archiveBounds.limitTarEntries.value,
  limitUncompressedBytes: archiveBounds.limitUncompressedBytes.value,
  limitArchiveBytes: archiveBounds.limitArchiveBytes.value,
  quotaSubmit: str("SCVS_E2E_QUOTA_SUBMIT") ? Number(str("SCVS_E2E_QUOTA_SUBMIT")) : undefined,
  windowSubmitMs: str("SCVS_E2E_WINDOW_SUBMIT_MS")
    ? Number(str("SCVS_E2E_WINDOW_SUBMIT_MS"))
    : undefined,
  quotaQuery: str("SCVS_E2E_QUOTA_QUERY") ? Number(str("SCVS_E2E_QUOTA_QUERY")) : undefined,
  windowQueryMs: str("SCVS_E2E_WINDOW_QUERY_MS")
    ? Number(str("SCVS_E2E_WINDOW_QUERY_MS"))
    : undefined,
  limitWallclockMs: str("SCVS_E2E_LIMIT_WALLCLOCK_MS")
    ? Number(str("SCVS_E2E_LIMIT_WALLCLOCK_MS"))
    : undefined,
  limitSseConnections: str("SCVS_E2E_LIMIT_SSE_CONNECTIONS")
    ? Number(str("SCVS_E2E_LIMIT_SSE_CONNECTIONS"))
    : undefined,
  jobRetryIntervalMs: retryParameters.interval.value,
  maxJobRetryAttempts: retryParameters.maxAttempts.value,
});
