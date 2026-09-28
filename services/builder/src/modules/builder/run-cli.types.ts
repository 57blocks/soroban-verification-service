import type { BuildMode, BuildRecipe, RebuildErrorCode, SandboxDiagnostics, SourceCanonicalisation, VerificationTarget } from "@scvs/core";
import type { MaterializedSource } from "./fetch-source.js";
import { cliTimeoutMs, dependencyPrefetchTimeoutMs, dockerCheckTimeoutMs, prefetchAllowedHosts } from "./run-cli.config.js";

export type RunCliMode = BuildMode;

export type RunCliRuntimeConfig = {
  cliTimeoutMs?: number;
  dependencyPrefetchTimeoutMs?: number;
  dockerCheckTimeoutMs?: number;
  dockerHost?: string;
  prefetchAllowedHosts?: string[];
  dockerCpus?: string;
  dockerMemory?: string;
  dockerPidsLimit?: string;
  dockerUser?: string;
};

export type RunCliInput = {
  mode: RunCliMode;
  target: VerificationTarget;
  build: BuildRecipe;
  source: MaterializedSource;
  expected_wasm_hash?: string;
  config?: RunCliRuntimeConfig;
};

export type RunCliOutcome = "verified" | "comparison_mismatch" | "cli_failure" | "built";

export type RunCliResult = {
  outcome: RunCliOutcome;
  runner: "stellar_contract_verify" | "docker_build_image_rebuild";
  exit_code: number | null;
  reason?: RebuildErrorCode;
  rebuilt_wasm_path?: string;
  rebuilt_wasm_hash?: string;
  rebuilt_wasm_size_bytes?: number;
  source_sha256?: string;
  source_canonicalisation?: SourceCanonicalisation;
  verify_attempt_reason?: string;
  diagnostics: Record<string, unknown>;
  sandbox_diagnostics?: SandboxDiagnostics;
};

export type BuildOutcomeClassification = "cli_failure" | "comparison_mismatch" | "success";

export type DockerResourceLimits = {
  args: string[];
  summaryArgs: string[];
  cpus?: string;
  memory?: string;
  pidsLimit?: string;
  capDrop: string;
  securityOpt: string;
};

export type DockerFinalSandboxOptions = {
  args: string[];
  summaryArgs: string[];
  readOnly: boolean;
  user: string;
  tmpfs: string[];
};

export type PrefetchEgressPolicyOk = {
  ok: true;
  allowed_hosts: string[];
};

export type PrefetchEgressPolicyRejected = {
  ok: false;
  allowed_hosts: string[];
  blocked_url: string;
  detail: string;
};

export type PrefetchEgressPolicy = PrefetchEgressPolicyOk | PrefetchEgressPolicyRejected;
