import { IsIn, IsNumberString, IsOptional, IsString } from "class-validator";

/** The sandbox's environment contract, validated once at boot by `ConfigModule.forRoot({ validate })`. */
export class BuilderEnvDto {
  @IsOptional()
  @IsIn(["production", "development", "test"], {
    message: "NODE_ENV must be one of: production, development, test",
  })
  NODE_ENV?: string;

  @IsOptional() @IsString()
  SCVS_JOB_PARAMS_JSON?: string;

  // Optional and transitional — see configuration.ts's note beside it.
  @IsOptional() @IsString()
  SCVS_JOB_PARAMS_URL?: string;

  @IsOptional() @IsString()
  SCVS_ARTIFACT_DIR?: string;

  // Optional because a single-container local run falls back to the OS temp dir.
  @IsOptional() @IsString()
  SCVS_HANDOFF_ROOT?: string;

  // `STELLAR_DATA_HOME` and `XDG_DATA_HOME` were declared here for the Stellar CLI subprocess.

  @IsOptional() @IsNumberString({}, { message: "SCVS_SOURCE_FETCH_TIMEOUT_MS must be a number" })
  SCVS_SOURCE_FETCH_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_SOURCE_ARCHIVE_BYTES must be a number" })
  SCVS_MAX_SOURCE_ARCHIVE_BYTES?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_TAR_TIMEOUT_MS must be a number" })
  SCVS_TAR_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_SOURCE_ARCHIVE_ENTRIES must be a number" })
  SCVS_MAX_SOURCE_ARCHIVE_ENTRIES?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_SOURCE_ARCHIVE_UNCOMPRESSED_BYTES must be a number" })
  SCVS_MAX_SOURCE_ARCHIVE_UNCOMPRESSED_BYTES?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_CLI_TIMEOUT_MS must be a number" })
  SCVS_CLI_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_DEPENDENCY_PREFETCH_TIMEOUT_MS must be a number" })
  SCVS_DEPENDENCY_PREFETCH_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_DOCKER_CHECK_TIMEOUT_MS must be a number" })
  SCVS_DOCKER_CHECK_TIMEOUT_MS?: string;

  @IsOptional() @IsString()
  SCVS_DOCKER_HOST?: string;

  @IsOptional() @IsString()
  SCVS_PREFETCH_ALLOWED_HOSTS?: string;

  @IsOptional() @IsString()
  SCVS_DOCKER_CPUS?: string;

  @IsOptional() @IsString()
  SCVS_DOCKER_MEMORY?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_DOCKER_PIDS_LIMIT must be a number" })
  SCVS_DOCKER_PIDS_LIMIT?: string;

  @IsOptional() @IsString()
  SCVS_DOCKER_USER?: string;
}
