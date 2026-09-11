import { isRetryableFailure } from "@scvs/core";
import {
  ConfigurationError,
  isConfigurationError,
} from "../src/config/configuration-error.js";
import {
  MISCONFIGURED_REASON_CODE,
  configurationFailure,
} from "../src/modules/verification-pipeline/failure-reason.util.js";
import { ComposerDispatchService } from "../src/modules/build-environments/composer-dispatch.service.js";
import { CachingBuildEnvironmentMaterializer } from "../src/modules/build-environments/caching-build-environment-materializer.service.js";
import type { AppConfigService } from "../src/config/configuration.js";
import type { EnvironmentsRepository } from "@scvs/db";
import type { ComposeIntent } from "@scvs/core";

/**
 * Because all three are `required: no`, the service booted healthy and every cli-legacy verification threw on
 * first use.
 */

const STAGING = { bucket: "stellar-scratch", region: "ap-southeast-2" };
const INTENT: ComposeIntent = {
  pair: { cliver: "25.1.0", rsver: "1.95.0" },
  template_version: "v1",
};

/** Only the keys `ComposerDispatchService` reads; anything absent is an unset variable. */
function configWith(overrides: Record<string, string | undefined>): AppConfigService {
  const values: Record<string, unknown> = { stagingStorage: STAGING, ...overrides };
  return { get: (key: string) => values[key] } as unknown as AppConfigService;
}

describe("configurationFailure", () => {
  it("records a missing variable as a NON-retryable failure", () => {
    const failure = configurationFailure(
      new ConfigurationError("SCVS_COMPOSER_JOB_QUEUE_ARN", "SCVS_COMPOSER_JOB_QUEUE_ARN is required"),
    );

    expect(failure).toEqual({
      reason: "build_failed",
      reasonCode: MISCONFIGURED_REASON_CODE,
      envName: "SCVS_COMPOSER_JOB_QUEUE_ARN",
      detail: "SCVS_COMPOSER_JOB_QUEUE_ARN is required",
    });
    expect(isRetryableFailure(failure!.reason)).toBe(false);
  });

  it("leaves every other throw on the retryable path", () => {
    // An RPC blip, a Batch rejection, a dropped connection — re-running those genuinely can produce a different
    // answer, and narrowing that set is not what this change is for.
    expect(configurationFailure(new Error("Batch rejected the submission"))).toBeUndefined();
    expect(configurationFailure("not even an Error")).toBeUndefined();
    expect(configurationFailure(undefined)).toBeUndefined();
  });

  it("recognises the error across module realizations", () => {
    // `instanceof` alone is not enough: the class is reachable through more than one specifier (a test's `src/`
    // import vs. the built `dist/` path), and two realizations fail `instanceof` against each other silently.
    const foreign = Object.assign(new Error("SCVS_X is required"), {
      name: "ConfigurationError",
      envName: "SCVS_X",
    });

    expect(isConfigurationError(foreign)).toBe(true);
    expect(configurationFailure(foreign)?.envName).toBe("SCVS_X");
  });

  it("does not mistake a same-named error carrying no variable for one", () => {
    const impostor = Object.assign(new Error("something else"), { name: "ConfigurationError" });
    expect(isConfigurationError(impostor)).toBe(false);
  });
});

describe("ComposerDispatchService's configuration checks", () => {
  const environments = {} as unknown as EnvironmentsRepository;

  /** Each variable is checked in turn, so the case for the second is "the first one is set". */
  it.each([
    ["SCVS_COMPOSER_JOB_QUEUE_ARN", {}],
    [
      "SCVS_COMPOSER_JOB_DEFINITION_ARN",
      { composerJobQueueArn: "arn:aws:batch:ap-southeast-2:1:job-queue/q" },
    ],
    [
      "SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI",
      {
        composerJobQueueArn: "arn:aws:batch:ap-southeast-2:1:job-queue/q",
        composerJobDefinitionArn: "arn:aws:batch:ap-southeast-2:1:job-definition/d:1",
      },
    ],
  ])("fails with %s named, before any AWS call", async (envName, set) => {
    const service = new ComposerDispatchService(configWith(set as Record<string, string>), environments);

    await expect(
      service.submitComposerJob({ environmentId: "env-1", intent: INTENT }),
    ).rejects.toMatchObject({ name: "ConfigurationError", envName });
  });
});

describe("the composition claim under a misconfiguration", () => {
  it("releases the claim and re-throws the error unchanged, so the pipeline can classify it", async () => {
    // Two properties in one, and they are separate: `releaseClaim` keeps a perfectly composable pair out of a
    // terminal `failed` row over an operator's missing variable (see the materializer's own comment), and
    // re-throwing the ORIGINAL error.
    const row = {
      environmentId: "env-1",
      status: "pending" as const,
      cliver: INTENT.pair.cliver,
      rsver: INTENT.pair.rsver,
      templateVersion: INTENT.template_version,
    };
    const calls: string[] = [];
    const environments = {
      async findOrCreate() {
        return row;
      },
      async claimForComposing() {
        calls.push("claimForComposing");
        return true;
      },
      async releaseClaim() {
        calls.push("releaseClaim");
      },
    } as unknown as EnvironmentsRepository;

    const composer = {
      async submitComposerJob() {
        throw new ConfigurationError(
          "SCVS_COMPOSER_JOB_QUEUE_ARN",
          "SCVS_COMPOSER_JOB_QUEUE_ARN is required to compose a build environment",
        );
      },
    } as unknown as ComposerDispatchService;

    const materializer = new CachingBuildEnvironmentMaterializer(environments, composer);
    const thrown = await materializer.materialize(INTENT, "job-1").catch((error: unknown) => error);

    expect(calls).toEqual(["claimForComposing", "releaseClaim"]);
    expect(configurationFailure(thrown)).toMatchObject({
      reason: "build_failed",
      envName: "SCVS_COMPOSER_JOB_QUEUE_ARN",
    });
  });
});
