import { IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString } from "class-validator";

/** This service's environment contract, validated once at boot. */
export class ComposerEnvDto {
  // The corollary of not extending `SharedEnvDto`, exactly as in `BuilderEnvDto`: the handful of genuinely
  // shared variables this unit *does* read have to be declared here rather than inherited.
  @IsOptional()
  @IsIn(["production", "development", "test"], {
    message: "NODE_ENV must be one of: production, development, test",
  })
  NODE_ENV?: string;

  // `XDG_DATA_HOME` was validated here for the same DooD reason the builder gave.

  @IsNotEmpty({
    message:
      "SCVS_COMPOSER_PARAMS_JSON is required — it is the composer's entire input, injected per job by " +
      "orchestrator-svc's SubmitJob call. A value baked into the job definition would be a stale spec.",
  })
  SCVS_COMPOSER_PARAMS_JSON!: string;

  @IsOptional() @IsString()
  SCVS_COMPOSER_TEMPLATE_DIR?: string;

  @IsOptional() @IsString()
  SCVS_ARTIFACT_DIR?: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_COMPOSER_BUILD_TIMEOUT_MS must be a number" })
  SCVS_COMPOSER_BUILD_TIMEOUT_MS?: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_COMPONENT_FETCH_TIMEOUT_MS must be a number" })
  SCVS_COMPONENT_FETCH_TIMEOUT_MS?: string;

  @IsOptional() @IsString()
  SCVS_COMPOSER_DOCKER_HOST?: string;
}
