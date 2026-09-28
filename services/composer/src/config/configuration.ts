import type { ConfigService } from "@nestjs/config";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const configuration = () => ({
  composerParamsJson: process.env.SCVS_COMPOSER_PARAMS_JSON,
  templateDir: process.env.SCVS_COMPOSER_TEMPLATE_DIR || "/app/docker/composed-environments",
  artifactDir: process.env.SCVS_ARTIFACT_DIR,
  buildTimeoutMs: numberEnv("SCVS_COMPOSER_BUILD_TIMEOUT_MS", 1_800_000),
  componentFetchTimeoutMs: numberEnv("SCVS_COMPONENT_FETCH_TIMEOUT_MS", 300_000),
  /** Separate from the builder's `SCVS_DOCKER_HOST` so one fleet's socket can never be the other's. */
  dockerHost: process.env.SCVS_COMPOSER_DOCKER_HOST,
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;

export type AppConfigService = ConfigService<AppConfig, true>;
