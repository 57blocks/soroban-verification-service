import { arweaveModes, arweaveSigners, ResultStorageEnvDto } from "@scvs/config";
import { IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString, IsUrl, Matches, ValidateBy, ValidateIf } from "class-validator";
import { buildArchitectures } from "./configuration.js";

const archivesThroughIrys = (env: OrchestratorSvcEnvDto) => (env.SCVS_ARWEAVE_MODE || "").toLowerCase() === "irys";
const archivesToIrysMainnet = (env: OrchestratorSvcEnvDto) =>
  archivesThroughIrys(env) && (env.SCVS_ARWEAVE_NETWORK || "").toLowerCase() === "mainnet";

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

  @IsOptional() @IsNumberString({}, { message: "SCVS_STAGED_SOURCE_SWEEP_INTERVAL_MS must be a number" })
  SCVS_STAGED_SOURCE_SWEEP_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_STAGED_SOURCE_SWEEP_BATCH_SIZE must be a number" })
  SCVS_STAGED_SOURCE_SWEEP_BATCH_SIZE?: string;

  @IsOptional()
  @IsIn(arweaveModes, {
    message: `SCVS_ARWEAVE_MODE must be one of: ${arweaveModes.join(", ")} (an unrecognised value silently disables archiving)`,
  })
  SCVS_ARWEAVE_MODE?: string;

  @IsOptional()
  @IsIn(["true", "false"], { message: "SCVS_SOURCE_ARCHIVE_ENABLED must be true or false" })
  SCVS_SOURCE_ARCHIVE_ENABLED?: string;

  @IsOptional()
  @IsIn(["mainnet", "devnet"], { message: "SCVS_ARWEAVE_NETWORK must be mainnet or devnet" })
  SCVS_ARWEAVE_NETWORK?: string;

  @IsOptional() @IsString()
  SCVS_ARWEAVE_RPC_URL?: string;

  @ValidateIf((env: OrchestratorSvcEnvDto) => env.SCVS_ARWEAVE_SIGNER !== undefined || archivesToIrysMainnet(env))
  @IsIn(arweaveSigners, {
    message: `SCVS_ARWEAVE_SIGNER must be one of: ${arweaveSigners.join(", ")}, and must be set to kms when archiving to Irys mainnet`,
  })
  @ValidateBy({
    name: "kmsOnIrysMainnet",
    validator: {
      validate: (value, args) => !archivesToIrysMainnet(args?.object as OrchestratorSvcEnvDto) || value === "kms",
      defaultMessage: () =>
        "SCVS_ARWEAVE_SIGNER must be kms when SCVS_ARWEAVE_MODE is irys and SCVS_ARWEAVE_NETWORK is mainnet — a mainnet wallet key never lives in process memory",
    },
  })
  SCVS_ARWEAVE_SIGNER?: string;

  @ValidateIf((env: OrchestratorSvcEnvDto) => archivesThroughIrys(env) && env.SCVS_ARWEAVE_SIGNER === "kms")
  @IsNotEmpty({ message: "SCVS_ARWEAVE_KMS_KEY_ID is required when SCVS_ARWEAVE_SIGNER is kms and SCVS_ARWEAVE_MODE is irys" })
  SCVS_ARWEAVE_KMS_KEY_ID?: string;

  @IsOptional() @IsString()
  SCVS_ARWEAVE_WALLET_PRIVATE_KEY?: string;

  // A KMS key's address cannot hold an Irys balance of its own: Irys credits a deposit to the on-chain sender, and
  // only the orchestrator may sign with the key. So a KMS signer always uploads on another wallet's approval.
  @ValidateIf(
    (env: OrchestratorSvcEnvDto) =>
      env.SCVS_ARWEAVE_PAID_BY !== undefined || (archivesThroughIrys(env) && env.SCVS_ARWEAVE_SIGNER === "kms"),
  )
  @IsNotEmpty({ message: "SCVS_ARWEAVE_PAID_BY is required when SCVS_ARWEAVE_SIGNER is kms and SCVS_ARWEAVE_MODE is irys" })
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: "SCVS_ARWEAVE_PAID_BY must be a 0x-prefixed 20-byte Ethereum address" })
  SCVS_ARWEAVE_PAID_BY?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: "SCVS_ARWEAVE_GATEWAY_URL must be a URL" })
  SCVS_ARWEAVE_GATEWAY_URL?: string;

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

  @IsOptional() @IsString()
  SCVS_BATCH_JOB_QUEUE_ARN_ARM64?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_JOB_QUEUE_ARN_AMD64?: string;

  @IsOptional()
  @IsIn(buildArchitectures, {
    message: `SCVS_BATCH_DEFAULT_ARCH must be one of: ${buildArchitectures.join(", ")}`,
  })
  SCVS_BATCH_DEFAULT_ARCH?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_JOB_DEFINITION_ARN_ARM64?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_JOB_DEFINITION_ARN_AMD64?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_MATERIALISE_CONTAINER_NAME?: string;

  @IsOptional() @IsString()
  SCVS_BATCH_RUNNER_CONTAINER_NAME?: string;

  @IsOptional()
  @IsIn(["env_json", "presigned_url"], {
    message: "SCVS_JOB_PARAMS_TRANSPORT must be one of: env_json, presigned_url",
  })
  SCVS_JOB_PARAMS_TRANSPORT?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_WORKER_CONCURRENCY must be a number" })
  SCVS_WORKER_CONCURRENCY?: string;

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

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_RETRY_INTERVAL_MS must be a number" })
  SCVS_JOB_RETRY_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_JOB_RETRY_ATTEMPTS must be a number" })
  SCVS_MAX_JOB_RETRY_ATTEMPTS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ARCHIVE_RECOVERY_INTERVAL_MS must be a number" })
  SCVS_ARCHIVE_RECOVERY_INTERVAL_MS?: string;

  @IsOptional() @IsIn(["true", "false"], { message: "SCVS_SINGLE_WRITER must be true or false" })
  SCVS_SINGLE_WRITER?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_STATUS_LINK_RECOVERY_INTERVAL_MS must be a number" })
  SCVS_STATUS_LINK_RECOVERY_INTERVAL_MS?: string;

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

  // Bounds an object the untrusted sandbox writes, whose size is attacker-chosen.
  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_REBUILT_WASM_BYTES must be a number" })
  SCVS_MAX_REBUILT_WASM_BYTES?: string;

  @IsOptional() @IsString()
  SCVS_COMPOSER_JOB_QUEUE_ARN?: string;

  @IsOptional() @IsString()
  SCVS_COMPOSER_JOB_DEFINITION_ARN?: string;

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
