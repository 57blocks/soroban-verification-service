/**
 * The harness's own configuration: where the deployment under test is, and which classes of case this run is
 * allowed to execute.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ExecutionMode = "AUTO" | "AUTO-INFRA" | "PERF" | "BROWSER" | "MANUAL";

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
  /** Master gate. Nothing in this package runs without it — see the README's "Why a gate". */
  readonly enabled: boolean;

  /** Identifies one harness invocation. Set it explicitly to reproduce a run. */
  readonly runId: string;

  /** `verification-svc`'s public origin, e.g. `https://verify.example.io`. */
  readonly verifyUrl?: string;
  /** `query-svc`'s public origin. */
  readonly queryUrl?: string;
  /** The public Web console origin, which may share the API origin behind the ALB. */
  readonly webUrl?: string;
  /**
   * The **static** origin the published result tree is served from — what `SCVS_PUBLIC_RESULT_ROOT` is set to
   * on the deployment.
   */
  readonly resultRoot?: string;

  readonly network: "mainnet" | "testnet";

  /** `AUTO-INFRA` cases mutate deployment state; they need their own opt-in and a maintenance window. */
  readonly allowInfra: boolean;
  /** Performance cases consume shared build capacity and run only through the explicit perf path. */
  readonly allowPerf: boolean;
  /** `BROWSER` cases drive a public Web deployment with Playwright. */
  readonly allowBrowser: boolean;
  readonly strictTrd: boolean;

  /** How long a submitted job may take to reach a terminal state before a case gives up. */
  readonly jobTimeoutMs: number;
  /** Poll interval while waiting on a job. */
  readonly pollIntervalMs: number;
  /** Per-request timeout for a single HTTP call. */
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

export const env: E2eEnv = Object.freeze({
  enabled: flag("SCVS_E2E"),
  runId: str("SCVS_E2E_RUN_ID") ?? randomUUID(),
  verifyUrl: str("SCVS_E2E_VERIFY_URL") && trimTrailingSlash(str("SCVS_E2E_VERIFY_URL")!),
  queryUrl: str("SCVS_E2E_QUERY_URL") && trimTrailingSlash(str("SCVS_E2E_QUERY_URL")!),
  webUrl: str("SCVS_E2E_WEB_URL") && trimTrailingSlash(str("SCVS_E2E_WEB_URL")!),
  resultRoot: str("SCVS_E2E_RESULT_ROOT") && trimTrailingSlash(str("SCVS_E2E_RESULT_ROOT")!),
  network,
  allowInfra: flag("SCVS_E2E_ALLOW_INFRA"),
  allowPerf: flag("SCVS_E2E_ALLOW_PERF"),
  allowBrowser: flag("SCVS_E2E_ALLOW_BROWSER"),
  strictTrd: flag("SCVS_E2E_STRICT_TRD"),
  jobTimeoutMs,
  pollIntervalMs,
  requestTimeoutMs,
});

/**
 * Which `config/deploy/<env>/` artefact describes the deployment under test — `dev`, `staging`, or unset for a
 * deployment this repository does not manage.
 */
const deployEnv = str("SCVS_E2E_ENV");

/** The two managed environments that may participate in the peer-outage E2E control. */
export type ManagedE2eEnvironment = "dev" | "staging";

/** `SCVS_E2E_ENV` remains open for ordinary E2E cases that bind a deployment artifact. */
export const managedE2eEnvironment: ManagedE2eEnvironment | undefined =
  deployEnv === "dev" || deployEnv === "staging" ? deployEnv : undefined;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** `config/deploy/<env>/<service>.json`'s shape, as far as this file reads it. */
interface DeclaredVariable {
  source?: string;
  value?: unknown;
  default?: unknown;
  note?: string;
  /** `false` when `value` is a mirror of the authoritative store (SSM) rather than the truth. */
  value_is_authoritative?: boolean;
}

interface DeployArtifact {
  target_env?: string;
  environment?: Record<string, DeclaredVariable | undefined>;
  /**
   * A reader that only looks at `environment` finds nothing for `SCVS_STORAGE_BUCKET` and quietly concludes the
   * artefact does not declare it.
   */
  ssm_parameters?: { variables?: Record<string, DeclaredVariable | undefined> };
  secrets?: { variables?: Record<string, DeclaredVariable | undefined> };
}

/** A declared variable, wherever in the artefact it is declared. */
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

/** The builder's deployment artefact, parsed once — or a hard failure. */
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

/** A positive literal effective value from a bound deployment descriptor. */
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

const retryParameters = Object.freeze({
  interval: deployLiteralNumber(orchestratorDeployArtifact, "SCVS_JOB_RETRY_INTERVAL_MS"),
  maxAttempts: deployLiteralNumber(orchestratorDeployArtifact, "SCVS_MAX_JOB_RETRY_ATTEMPTS"),
});

export const retryPolicyProvenance = Object.freeze({
  interval: retryParameters.interval.describe,
  maxAttempts: retryParameters.maxAttempts.describe,
});

/** One `SCVS_MAX_SOURCE_ARCHIVE_*` bound, read from the bound artefact. */
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

/** The three archive bounds, and where each came from. */
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
        `live-config evidence for a deployment this repository does not manage. See ` +
        `docs/qa/e2e-missing-coverage-priority.md § "SEC-03 的准确补齐边界".`
    );
  }
}

function archiveBound(
  variable: string,
  parameter: string
): { value?: number; describe: string } {
  if (!deployEnv) {
    return {
      describe:
        `${parameter}: unavailable — SCVS_E2E_ENV is unset, so no config/deploy artefact is bound, ` +
        `and the deployment publishes no archive bounds to read instead`,
    };
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
  limitTarEntries: archiveBound("SCVS_MAX_SOURCE_ARCHIVE_ENTRIES", "LIMIT_TAR_ENTRIES"),
  limitUncompressedBytes: archiveBound(
    "SCVS_MAX_SOURCE_ARCHIVE_UNCOMPRESSED_BYTES",
    "LIMIT_UNCOMPRESSED_BYTES"
  ),
  limitArchiveBytes: archiveBound("SCVS_MAX_SOURCE_ARCHIVE_BYTES", "LIMIT_ARCHIVE_BYTES"),
});

/** Human-readable provenance for the three archive bounds. */
export const archiveLimitProvenance: Readonly<Record<keyof typeof archiveBounds, string>> =
  Object.freeze({
    limitTarEntries: archiveBounds.limitTarEntries.describe,
    limitUncompressedBytes: archiveBounds.limitUncompressedBytes.describe,
    limitArchiveBytes: archiveBounds.limitArchiveBytes.describe,
  });

/** How `E2E-SRC-03` observes whether a private upload's staging object still exists. */
export type StagingObserver =
  | { readonly kind: "probe"; readonly probeUrl: string; readonly describe: string }
  | {
      readonly kind: "s3";
      readonly bucket: string;
      readonly region: string;
      readonly describe: string;
    }
  | { readonly kind: "absent"; readonly describe: string };

/**
 * The deployment's own staging bucket, as its artefact declares it — used only to refuse it as a direct-S3
 * target.
 */
function boundDeploymentStagingBucket(): string | undefined {
  if (!deployEnv) return undefined;
  const artifact = loadDeployArtifact("verification-svc")?.artifact;
  if (!artifact) return undefined;
  const declared = declaredVariable(artifact, "SCVS_STORAGE_BUCKET");
  const raw = declared?.value ?? declared?.default;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

function resolveStagingObserver(): StagingObserver {
  const probeUrl = str("SCVS_E2E_STAGING_PROBE_URL");
  if (probeUrl) {
    return {
      kind: "probe",
      probeUrl: trimTrailingSlash(probeUrl),
      describe: `existence-only probe at ${trimTrailingSlash(probeUrl)}`,
    };
  }

  const bucket = str("SCVS_E2E_STAGING_BUCKET");
  if (!bucket) {
    return {
      kind: "absent",
      describe:
        "no staging observer: set SCVS_E2E_STAGING_PROBE_URL (existence-only probe, required on a " +
        "shared bucket) or SCVS_E2E_STAGING_BUCKET + SCVS_E2E_STAGING_REGION against an isolated " +
        "E2E bucket — see E2E-SRC-03's evidence boundary",
    };
  }

  const region = str("SCVS_E2E_STAGING_REGION");
  if (!region) {
    throw new Error(
      "SCVS_E2E_STAGING_BUCKET is set but SCVS_E2E_STAGING_REGION is not. Both are required, and " +
        "neither is inferred: a region guessed from a default would HEAD a different bucket of the " +
        "same name in another region and report `absent` for an object that exists."
    );
  }

  const deploymentBucket = boundDeploymentStagingBucket();
  if (deploymentBucket && deploymentBucket === bucket) {
    throw new Error(
      `SCVS_E2E_STAGING_BUCKET=${bucket} is the bucket config/deploy/${deployEnv}/verification-svc.json ` +
        `declares as the deployment's own SCVS_STORAGE_BUCKET. HeadObject requires s3:GetObject, so ` +
        `credentials for it can read every submitter's private tarball in that bucket — which is the ` +
        `privacy boundary E2E-SRC-03 exists to protect. Use an isolated E2E staging bucket, or set ` +
        `SCVS_E2E_STAGING_PROBE_URL to an existence-only probe that holds the permission itself.`
    );
  }

  return {
    kind: "s3",
    bucket,
    region,
    describe: `HeadObject on s3://${bucket} (${region})`,
  };
}

export const stagingObserver: StagingObserver = Object.freeze(resolveStagingObserver());

/** The approved window between a job's first terminal observation and the staging object disappearing. */
export const stagingDeletionDeadlineMs: number | undefined = (() => {
  const raw = str("SCVS_E2E_STAGING_DELETION_DEADLINE_MS");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `SCVS_E2E_STAGING_DELETION_DEADLINE_MS must be a positive number of milliseconds; received ${JSON.stringify(raw)}.`
    );
  }
  return value;
})();

/** A structurally valid but deliberately unresolved contract id for `E2E-SRC-03/on_internal_error`. */
export const internalErrorTargetContractId: string | undefined = (() => {
  const contractId = str("SCVS_E2E_INTERNAL_ERROR_CONTRACT_ID");
  if (!contractId) return undefined;
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
    throw new Error(
      "SCVS_E2E_INTERNAL_ERROR_CONTRACT_ID must be a valid Stellar contract id for a controlled " +
        "unresolved-target test; received " +
        JSON.stringify(contractId)
    );
  }
  return contractId;
})();

/** Two control-plane capabilities the SRC group needs, and the reason they are endpoints rather than flags. */
const ASSUMPTION_ENV_NAMES = [
  "SCVS_E2E_ASSUME_SOURCE_DARK",
  "SCVS_E2E_ASSUME_RETENTION_FAILED",
] as const;

for (const name of ASSUMPTION_ENV_NAMES) {
  if (str(name)) {
    throw new Error(
      `${name} is not read, and will not be. E2E-SRC-08 and E2E-SRC-11 are about states somebody has ` +
        `to actually establish — a source that really 404s, an object-store prefix whose writes really ` +
        `fail. Asserting the premise from an environment variable would make the case report a green ` +
        `result for a condition that never existed. Configure SCVS_E2E_DARK_SOURCE_CONTROL_URL or ` +
        `SCVS_E2E_OBJECT_STORE_FAULT_URL instead, or let the case skip.`
    );
  }
}

export type ControlEndpoint =
  | { readonly kind: "endpoint"; readonly controlUrl: string; readonly describe: string }
  | { readonly kind: "absent"; readonly describe: string };

function controlEndpoint(name: string, absent: string): ControlEndpoint {
  const raw = str(name);
  if (!raw) return { kind: "absent", describe: absent };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL; received ${JSON.stringify(raw)}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be http or https; received ${parsed.protocol}.`);
  }
  return {
    kind: "endpoint",
    controlUrl: trimTrailingSlash(raw),
    describe: `${name}=${trimTrailingSlash(raw)}`,
  };
}

/** Takes `F-DARK`'s source URL offline and brings it back — `POST` with `{"available": boolean}`. */
export const darkSourceControl: ControlEndpoint = Object.freeze(
  controlEndpoint(
    "SCVS_E2E_DARK_SOURCE_CONTROL_URL",
    "no dark-source control endpoint: run test/fixtures/e2e/dark-source-server.mjs where the " +
      "deployment can reach it and set SCVS_E2E_DARK_SOURCE_CONTROL_URL to its /control route " +
      "(registry.yaml's F-DARK entry: \"expose the fixture server at a URL reachable by the " +
      "deployment under test\")"
  )
);

/**
 * Prerequisite P12, scoped to one prefix — `POST` with `{"prefix": "sources/", "mode": "fail_writes" |
 * "healthy"}`.
 */
export const objectStoreFaultInjector: ControlEndpoint = Object.freeze(
  controlEndpoint(
    "SCVS_E2E_OBJECT_STORE_FAULT_URL",
    "no object-store fault injector (plan prerequisite P12): set SCVS_E2E_OBJECT_STORE_FAULT_URL to " +
      "a control endpoint that can fail writes under a single result-root prefix while leaving the " +
      "others healthy"
  )
);

/**
 * A 📐-marked case must read its parameter from the deployment rather than invent one — so each is optional
 * here, and a case whose parameter is absent skips, naming it.
 */
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
