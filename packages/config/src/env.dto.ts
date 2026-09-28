import { IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString, Matches, ValidateIf } from "class-validator";

const resultStorageKinds = ["filesystem", "s3", "r2"] as const;

const arweaveModes = ["disabled", "dry-run", "dry_run", "irys"] as const;

const nodeEnvs = ["production", "development", "test"] as const;

export class SharedEnvDto {
  @IsOptional()
  @IsIn(nodeEnvs, { message: `NODE_ENV must be one of: ${nodeEnvs.join(", ")}` })
  NODE_ENV?: string;

  @IsOptional() @IsNumberString({}, { message: "PORT must be a number" })
  PORT?: string;

  @IsOptional() @IsString()
  CORS_ORIGIN?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_DRAIN_GRACE_MS must be a number" })
  SCVS_DRAIN_GRACE_MS?: string;

  // Positive, not merely numeric: Node reads `0` as no deadline.
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

  // Must stay above the fronting balancer's idle timeout.
  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_KEEPALIVE_TIMEOUT_MS must be a positive number of milliseconds",
  })
  SCVS_KEEPALIVE_TIMEOUT_MS?: string;

  // `0` is accepted: it declares nothing fronts this server and skips the keep-alive comparison.
  @IsOptional()
  @Matches(/^\d+$/, {
    message: "SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS must be a whole number of milliseconds",
  })
  SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS?: string;

  @IsOptional() @IsNotEmpty({ message: "AWS_REGION must not be empty when set" })
  AWS_REGION?: string;

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

  @ValidateIf(
    (env: ResultStorageEnvDto) =>
      (env.SCVS_PUBLISHER_STORAGE || "filesystem").toLowerCase() !== "filesystem" ||
      env.SCVS_PUBLISHER_BUCKET !== undefined,
  )
  @IsNotEmpty({
    message: "SCVS_PUBLISHER_BUCKET is required when SCVS_PUBLISHER_STORAGE is s3 or r2, and must not be empty",
  })
  SCVS_PUBLISHER_BUCKET?: string;

  // `SCVS_R2_REGION` defaults to the literal `auto`, which real AWS S3 rejects.
  @IsOptional() @IsString()
  SCVS_PUBLISHER_PREFIX?: string;

  @IsOptional() @IsNotEmpty({ message: "SCVS_R2_REGION must not be empty when set" })
  SCVS_R2_REGION?: string;

  @IsOptional() @IsString()
  SCVS_R2_ENDPOINT?: string;

  @IsOptional() @IsString()
  SCVS_R2_ACCOUNT_ID?: string;

  @IsOptional() @IsNotEmpty({ message: "SCVS_VERIFIER_ID must not be empty when set" })
  SCVS_VERIFIER_ID?: string;

  @IsOptional() @IsString()
  SCVS_VERIFIER_DISPLAY_NAME?: string;

  @IsOptional() @IsNotEmpty({ message: "SCVS_VERIFIER_POLICY_ID must not be empty when set" })
  SCVS_VERIFIER_POLICY_ID?: string;
}

export { arweaveModes, nodeEnvs, resultStorageKinds };

export { createEnvValidator, EnvValidationError } from "@scvs/core";
