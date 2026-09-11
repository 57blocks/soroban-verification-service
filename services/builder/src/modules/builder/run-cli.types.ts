// Shared shapes for the builder's rebuild pipeline. No logic, no owner — every module below imports from here.

import type { BuildMode, BuildRecipe, SandboxDiagnostics, SourceCanonicalisation, VerificationTarget } from "@scvs/core";
import type { MaterializedSource } from "./fetch-source.js";
import { cliTimeoutMs, dependencyPrefetchTimeoutMs, dockerCheckTimeoutMs, prefetchAllowedHosts } from "./run-cli.config.js";

export type RunCliMode = BuildMode;

/**
 * Sourced from `ConfigService` by the one Nest-managed caller in this chain (builder.service.ts, injected via
 * its constructor) and passed down through `RunCliInput.config`.
 */
export type RunCliRuntimeConfig = {
  // `cliTimeoutMs` survives them: it bounds `docker` and `tar`, not the CLI.
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
  /**
   * Informational only (used for diagnostics annotation and as a fallback value when the `stellar contract
   * verify` CLI's own stdout does not print a hash).
   */
  expected_wasm_hash?: string;
  // `rpc_url` stood here, carried from `BatchJobParams` for the verify path to dial.
  config?: RunCliRuntimeConfig;
};

/** This is */
export type RunCliOutcome = "verified" | "comparison_mismatch" | "cli_failure" | "built";

export type RunCliResult = {
  outcome: RunCliOutcome;
  runner: "stellar_contract_verify" | "docker_build_image_rebuild";
  exit_code: number | null;
  /** Set when outcome === "cli_failure". */
  reason?: string;
  rebuilt_wasm_path?: string;
  rebuilt_wasm_hash?: string;
  rebuilt_wasm_size_bytes?: number;
  /**
   * Absent on `cli_failure` (no build to attribute a source hash to) and for the `git` source type (no archive
   * to hash).
   */
  source_sha256?: string;
  /** Copied from the handoff, not derived here — the materialiser is what peels and rebuilds. */
  source_canonicalisation?: SourceCanonicalisation;
  verify_attempt_reason?: string;
  /** Rich, unstructured context for logs/troubleshooting. */
  diagnostics: Record<string, unknown>;
  /** Schema-conformant subset (packages/core's SandboxDiagnostics) for recipe.json. */
  sandbox_diagnostics?: SandboxDiagnostics;
};

/**
 * Collapses the 4-value `RunCliOutcome` down to the 3-value classification services/orchestrator-svc's
 * fallback.ts (and, once reconstructed from `recipe.json`, services/orchestrator-svc's on-batch-event.ts)
 * actually branches on.
 */
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
