import type { ConfigService } from "@nestjs/config";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `@nestjs/config`'s single loader for this service. */
const configuration = () => ({
  /** One `ComposerJobParams` document — the composer's entire input. See `ComposerService.readParams`. */
  composerParamsJson: process.env.SCVS_COMPOSER_PARAMS_JSON,
  /**
   * Where the composition templates live *inside this image*, baked at image build time by
   * `docker/composer.Dockerfile`.
   */
  templateDir: process.env.SCVS_COMPOSER_TEMPLATE_DIR || "/app/docker/composed-environments",
  artifactDir: process.env.SCVS_ARTIFACT_DIR,
  /** The `docker build` plus the ECR push. */
  buildTimeoutMs: numberEnv("SCVS_COMPOSER_BUILD_TIMEOUT_MS", 1_800_000),
  /** Per-component fetch, and the smoke-test runs. */
  componentFetchTimeoutMs: numberEnv("SCVS_COMPONENT_FETCH_TIMEOUT_MS", 300_000),
  /** Separate from the builder's `SCVS_DOCKER_HOST` so one fleet's socket can never be the other's. */
  dockerHost: process.env.SCVS_COMPOSER_DOCKER_HOST,
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;

/** Inject this instead of the bare `ConfigService`. The DI token is still `ConfigService`. */
export type AppConfigService = ConfigService<AppConfig, true>;
