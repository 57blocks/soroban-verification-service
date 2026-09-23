import { IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString, Matches, ValidateIf } from "class-validator";

/** All three of these fail **silently** without it: */

/** The storage kinds `packages/storage-layout` actually implements. */
// `gcs` was accepted here for a backend that was never written: it passed boot and then failed at first
// publish in one service and silently disabled reads in the other. A kind with no backend is a boot error.
const resultStorageKinds = ["filesystem", "s3", "r2"] as const;

/** Accepted spellings of `SCVS_ARWEAVE_MODE`, matching `getArweaveConfig()`'s own mapping. */
const arweaveModes = ["disabled", "dry-run", "dry_run", "irys"] as const;

/** The only `NODE_ENV` values anything in this repository compares against. */
const nodeEnvs = ["production", "development", "test"] as const;

/**
 * Variables more than one service reads. Each service's own DTO extends this and adds its own — see
 * `services/<name>/src/config/env.dto.ts`.
 */
export class SharedEnvDto {
  @IsOptional()
  @IsIn(nodeEnvs, { message: `NODE_ENV must be one of: ${nodeEnvs.join(", ")}` })
  NODE_ENV?: string;

  @IsOptional() @IsNumberString({}, { message: "PORT must be a number" })
  PORT?: string;

  @IsOptional() @IsString()
  CORS_ORIGIN?: string;

  // How long a task keeps serving after SIGTERM so `/health/ready` can go false and the balancer can deregister
  // it before the process leaves.
  @IsOptional() @IsNumberString({}, { message: "SCVS_DRAIN_GRACE_MS must be a number" })
  SCVS_DRAIN_GRACE_MS?: string;

  // Positive, not merely numeric, on all three: Node reads a `0` as "no deadline", which is the fail-open
  // `applyHttpServerTimeouts` exists to remove. Refusing it here reports it as a configuration mistake at boot
  // rather than as a server that starts clean and holds connections forever.
  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_REQUEST_TIMEOUT_MS must be a positive number of milliseconds",
  })
  SCVS_REQUEST_TIMEOUT_MS?: string;

  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_HEADERS_TIMEOUT_MS must be a positive number of milliseconds",
  })
  SCVS_HEADERS_TIMEOUT_MS?: string;

  // Must stay above the fronting balancer's idle timeout; `applyHttpServerTimeouts` enforces the ordering
  // against the other two, and @scvs/core's FRONTING_PROXY_IDLE_TIMEOUT_MS carries the balancer's own number.
  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_KEEPALIVE_TIMEOUT_MS must be a positive number of milliseconds",
  })
  SCVS_KEEPALIVE_TIMEOUT_MS?: string;

  // Zero IS accepted here, unlike the three above: it is how a deployment with nothing in front of it declares
  // that, and `applyHttpServerTimeouts` then skips the keep-alive comparison instead of failing the boot.
  @IsOptional()
  @Matches(/^\d+$/, {
    message: "SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS must be a whole number of milliseconds",
  })
  SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS?: string;

  // Not only the AWS SDK's region: `getStagingStorageConfig()` reads it too, and its fallback is `us-east-1`,
  // so an unset value points the staging-bucket client at the wrong region and fails per-object rather than at
  // boot.
  @IsOptional() @IsNotEmpty({ message: "AWS_REGION must not be empty when set" })
  AWS_REGION?: string;

  // Presence is enforced by @scvs/db's toConnectionString(), not here — see the note above.
  @IsOptional() @IsString()
  DATABASE_URL?: string;

  @IsOptional() @IsString()
  POSTGRES_HOST?: string;

  @IsOptional() @IsNumberString({}, { message: "POSTGRES_PORT must be a number" })
  POSTGRES_PORT?: string;

  @IsOptional() @IsString()
  POSTGRES_DB?: string;

  @IsOptional() @IsString()
  POSTGRES_USER?: string;

  @IsOptional() @IsString()
  POSTGRES_PASSWORD?: string;

  // `getDatabaseUrl()` tests `=== "true"`, so every other spelling means "off".
  @IsOptional()
  @IsIn(["true", "false"], { message: 'POSTGRES_SSL must be "true" or "false"' })
  POSTGRES_SSL?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_DB_CONNECTION_TIMEOUT_MS must be a number" })
  SCVS_DB_CONNECTION_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_DB_IDLE_TIMEOUT_MS must be a number" })
  SCVS_DB_IDLE_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_DB_POOL_MAX must be a number" })
  SCVS_DB_POOL_MAX?: string;

  @IsOptional() @IsString()
  STELLAR_CLI_PATH?: string;

  @IsOptional() @IsString()
  SCVS_ARTIFACT_DIR?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_CLI_TIMEOUT_MS must be a number" })
  SCVS_CLI_TIMEOUT_MS?: string;

  @IsOptional() @IsString()
  SCVS_MAINNET_RPC_URL?: string;
}

/** The subset of `resultStorageConfigFromEnv()`/`getVerifierIdentity()` inputs worth rejecting at boot. */
export class ResultStorageEnvDto extends SharedEnvDto {
  @IsOptional()
  @IsIn(resultStorageKinds, {
    message: `SCVS_PUBLISHER_STORAGE must be one of: ${resultStorageKinds.join(", ")}`,
  })
  SCVS_PUBLISHER_STORAGE?: string;

  @IsOptional() @IsString()
  SCVS_PUBLIC_RESULT_ROOT?: string;

  @IsOptional() @IsString()
  SCVS_RESULT_ROOT?: string;

  // The cross-field rule, which used to be checked per-operation inside two services instead: an object
  // backend with no bucket can only fail one request at a time, each time with a less obvious error.
  @ValidateIf(
    (env: ResultStorageEnvDto) =>
      (env.SCVS_PUBLISHER_STORAGE || "filesystem").toLowerCase() !== "filesystem" ||
      env.SCVS_PUBLISHER_BUCKET !== undefined,
  )
  @IsNotEmpty({
    message: "SCVS_PUBLISHER_BUCKET is required when SCVS_PUBLISHER_STORAGE is s3 or r2, and must not be empty",
  })
  SCVS_PUBLISHER_BUCKET?: string;

  // `SCVS_R2_REGION` is still the hazardous kind: it defaults to the literal string `auto`, which real AWS S3
  // rejects outright.
  @IsOptional() @IsString()
  SCVS_PUBLISHER_PREFIX?: string;

  @IsOptional() @IsNotEmpty({ message: "SCVS_R2_REGION must not be empty when set" })
  SCVS_R2_REGION?: string;

  // R2/custom-endpoint backends only; unset for AWS S3. `SCVS_R2_ACCOUNT_ID` exists solely to derive the
  // endpoint when `SCVS_R2_ENDPOINT` is absent.
  @IsOptional() @IsString()
  SCVS_R2_ENDPOINT?: string;

  @IsOptional() @IsString()
  SCVS_R2_ACCOUNT_ID?: string;

  // They live here rather than on one service's DTO because both services extend this class, and the two reads
  // must agree: the `verifier.name` a consumer sees on `202` has to match what the published documents carry.
  @IsOptional() @IsNotEmpty({ message: "SCVS_VERIFIER_ID must not be empty when set" })
  SCVS_VERIFIER_ID?: string;

  @IsOptional() @IsString()
  SCVS_VERIFIER_DISPLAY_NAME?: string;

  @IsOptional() @IsNotEmpty({ message: "SCVS_VERIFIER_POLICY_ID must not be empty when set" })
  SCVS_VERIFIER_POLICY_ID?: string;
}

export { arweaveModes, nodeEnvs, resultStorageKinds };

// `createEnvValidator`/`EnvValidationError` live in @scvs/core so services/builder can validate its own
// environment without depending on this package.
export { createEnvValidator, EnvValidationError } from "@scvs/core";
