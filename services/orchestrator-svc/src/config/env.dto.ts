import { arweaveModes, ResultStorageEnvDto } from "@scvs/config";
import { IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString, IsUrl, Matches } from "class-validator";
import { buildArchitectures } from "./configuration.js";

/** This service's environment contract, validated once at boot by `ConfigModule.forRoot({ validate })`. */
export class OrchestratorSvcEnvDto extends ResultStorageEnvDto {
  @IsNotEmpty({
    message:
      "SCVS_STORAGE_BUCKET is required — the staging bucket the Builder hands recipe.json back through",
  })
  SCVS_STORAGE_BUCKET!: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS must be a number" })
  SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_BUILD_LOG_RETENTION_MS must be a number" })
  SCVS_BUILD_LOG_RETENTION_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_BUILD_LOG_SWEEP_INTERVAL_MS must be a number" })
  SCVS_BUILD_LOG_SWEEP_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_BUILD_LOG_SWEEP_BATCH_SIZE must be a number" })
  SCVS_BUILD_LOG_SWEEP_BATCH_SIZE?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_RETENTION_MS must be a number" })
  SCVS_JOB_RETENTION_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_RETENTION_SWEEP_INTERVAL_MS must be a number" })
  SCVS_JOB_RETENTION_SWEEP_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_RETENTION_BATCH_SIZE must be a number" })
  SCVS_JOB_RETENTION_BATCH_SIZE?: string;

  @IsOptional()
  @IsIn(arweaveModes, {
    message: `SCVS_ARWEAVE_MODE must be one of: ${arweaveModes.join(", ")} (an unrecognised value silently disables archiving)`,
  })
  SCVS_ARWEAVE_MODE?: string;

  // Independent of SCVS_ARWEAVE_MODE (mainnet-source-archive design.md §8, MSA-5) — defaults off.
  @IsOptional()
  @IsIn(["true", "false"], { message: "SCVS_SOURCE_ARCHIVE_ENABLED must be true or false" })
  SCVS_SOURCE_ARCHIVE_ENABLED?: string;

  // A deployment that should produce durable archives sets this to "mainnet" explicitly.
  @IsOptional()
  @IsIn(["mainnet", "devnet"], { message: "SCVS_ARWEAVE_NETWORK must be mainnet or devnet" })
  SCVS_ARWEAVE_NETWORK?: string;

  // Ethereum RPC endpoint the archiving wallet signs through. Only meaningful with `SCVS_ARWEAVE_MODE=irys`;
  // devnet has a working default (getArweaveConfig()) so this is unset in local dev.
  @IsOptional() @IsString()
  SCVS_ARWEAVE_RPC_URL?: string;

  // Only meaningful with `SCVS_ARWEAVE_MODE=irys`.
  @IsOptional() @IsString()
  SCVS_ARWEAVE_WALLET_PRIVATE_KEY?: string;

  // The gateway an archived report's results_urls entry is built against (`${gatewayUrl}/${tx_id}`).
  @IsOptional()
  @IsUrl({ require_tld: false }, { message: "SCVS_ARWEAVE_GATEWAY_URL must be a URL" })
  SCVS_ARWEAVE_GATEWAY_URL?: string;

  // Every field is optional with a working default matching what was hardcoded before, so an unset environment
  // still publishes the same policy content this verifier always has.
  @IsOptional() @IsString()
  SCVS_POLICY_ACCEPTED_TRUST_LEVELS?: string;

  @IsOptional() @IsIn(["true", "false"], { message: "SCVS_POLICY_DIGEST_PINNED_ONLY must be true or false" })
  SCVS_POLICY_DIGEST_PINNED_ONLY?: string;

  @IsOptional() @IsIn(["true", "false"], { message: "SCVS_POLICY_TAG_ONLY_ALLOWED must be true or false" })
  SCVS_POLICY_TAG_ONLY_ALLOWED?: string;

  @IsOptional() @IsIn(["true", "false"], { message: "SCVS_POLICY_ARBITRARY_IMAGES_ALLOWED must be true or false" })
  SCVS_POLICY_ARBITRARY_IMAGES_ALLOWED?: string;

  @IsOptional() @IsIn(["true", "false"], { message: "SCVS_POLICY_REQUIRE_TARBALL_SHA256 must be true or false" })
  SCVS_POLICY_REQUIRE_TARBALL_SHA256?: string;

  @IsOptional() @IsIn(["true", "false"], { message: "SCVS_POLICY_RETAIN_ARTIFACTS must be true or false" })
  SCVS_POLICY_RETAIN_ARTIFACTS?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: "SCVS_JOB_STATE_CHANGE_QUEUE_URL must be a URL" })
  SCVS_JOB_STATE_CHANGE_QUEUE_URL?: string;

  // One queue ARN per architecture.
  @IsOptional() @IsString()
  SCVS_BATCH_JOB_QUEUE_ARN_ARM64?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_JOB_QUEUE_ARN_AMD64?: string;

  // Breaks the tie for an image that runs on both, and is the fallback when the registry cannot tell us at all.
  @IsOptional()
  @IsIn(buildArchitectures, {
    message: `SCVS_BATCH_DEFAULT_ARCH must be one of: ${buildArchitectures.join(", ")}`,
  })
  SCVS_BATCH_DEFAULT_ARCH?: string;

  // Named with the same suffixes as that pair, so the four architecture-scoped dispatch variables read as one
  // set.
  @IsOptional() @IsString()
  SCVS_BATCH_JOB_DEFINITION_ARN_ARM64?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_JOB_DEFINITION_ARN_AMD64?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_MATERIALISE_CONTAINER_NAME?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_RUNNER_CONTAINER_NAME?: string;

  // Validated rather than defaulted-on-typo: a typo would silently keep the transport whose payload AWS was
  // already rejecting in staging.
  @IsOptional()
  @IsIn(["env_json", "presigned_url"], {
    message: "SCVS_JOB_PARAMS_TRANSPORT must be one of: env_json, presigned_url",
  })
  SCVS_JOB_PARAMS_TRANSPORT?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_WORKER_CONCURRENCY must be a number" })
  SCVS_WORKER_CONCURRENCY?: string;

  // Unset default: see clampTestnetConcurrency in configuration.ts.
  @IsOptional() @IsNumberString({}, { message: "SCVS_WORKER_CONCURRENCY_TESTNET must be a number" })
  SCVS_WORKER_CONCURRENCY_TESTNET?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_WORKER_POLL_INTERVAL_MS must be a number" })
  SCVS_WORKER_POLL_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_PUBLISH_RECOVERY_INTERVAL_MS must be a number" })
  SCVS_PUBLISH_RECOVERY_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_PUBLISH_STALE_MS must be a number" })
  SCVS_PUBLISH_STALE_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_PUBLISH_ATTEMPTS must be a number" })
  SCVS_MAX_PUBLISH_ATTEMPTS?: string;

  // The ceiling and the cadence, mirroring the two above.
  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_RETRY_INTERVAL_MS must be a number" })
  SCVS_JOB_RETRY_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_JOB_RETRY_ATTEMPTS must be a number" })
  SCVS_MAX_JOB_RETRY_ATTEMPTS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ARCHIVE_RECOVERY_INTERVAL_MS must be a number" })
  SCVS_ARCHIVE_RECOVERY_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_SOURCE_ARCHIVE_CLAIM_TIMEOUT_MS must be a number" })
  SCVS_SOURCE_ARCHIVE_CLAIM_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_REPORT_ARCHIVE_CLAIM_TIMEOUT_MS must be a number" })
  SCVS_REPORT_ARCHIVE_CLAIM_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_REBUILD_REAPER_INTERVAL_MS must be a number" })
  SCVS_REBUILD_REAPER_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_REBUILD_DISPATCH_TIMEOUT_MS must be a number" })
  SCVS_REBUILD_DISPATCH_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_REBUILD_RUN_TIMEOUT_MS must be a number" })
  SCVS_REBUILD_RUN_TIMEOUT_MS?: string;

  // That object is written by the untrusted sandbox, so its size is attacker-chosen: without a bound, one PUT
  // decides how much memory the orchestrator buffers.
  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_REBUILT_WASM_BYTES must be a number" })
  SCVS_MAX_REBUILT_WASM_BYTES?: string;

  // ── Composed build environments (ADR-017) ──────────────────────────────────────────────────────
  // The composer fleet's own queue and job definition, separate from the builder's above.
  @IsOptional() @IsString()
  SCVS_COMPOSER_JOB_QUEUE_ARN?: string;

  @IsOptional() @IsString()
  SCVS_COMPOSER_JOB_DEFINITION_ARN?: string;

  // A bare ECR repository URI — no tag, no `@sha256:`.
  @IsOptional()
  @Matches(/^[^\s@:]+(?::\d+)?\/[^\s@:]+$/, {
    message:
      "SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI must be a bare repository URI such as " +
      "<account>.dkr.ecr.<region>.amazonaws.com/scvs-composed-environments — no tag and no @sha256: suffix",
  })
  SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI?: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_ENVIRONMENT_COMPOSE_TIMEOUT_MS must be a number" })
  SCVS_ENVIRONMENT_COMPOSE_TIMEOUT_MS?: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_ENVIRONMENT_RECONCILER_INTERVAL_MS must be a number" })
  SCVS_ENVIRONMENT_RECONCILER_INTERVAL_MS?: string;
}
