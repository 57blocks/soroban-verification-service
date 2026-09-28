import { jest } from "@jest/globals";
import type { ConfigService } from "@nestjs/config";
import type { EnvironmentRecord, EnvironmentsRepository } from "@scvs/db";
import {
  composedEnvironmentRecipeHash,
  type ComposedEnvironmentRecipe,
  type ComposerArtifact,
} from "@scvs/core";
import type { AppConfigService } from "../src/config/configuration.js";

const getObjectText = jest.fn<(...args: unknown[]) => Promise<string | undefined>>();

jest.unstable_mockModule("@scvs/aws", () => ({
  createS3Client: () => ({}),
  getObjectText,
  createBatchClient: () => ({}),
  describeJob: async () => undefined,
  presignPutUrl: async () => "https://example.invalid/put",
  submitJob: async () => "batch-job-1",
}));

const { EnvironmentOutcomeService } = await import(
  "../src/modules/build-environments/environment-outcome.service.js"
);

const PAIR = { cliver: "25.1.0", rsver: "1.95.0" };
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;

const RECIPE: ComposedEnvironmentRecipe = {
  schema: "scvs-composed-environment-v1",
  template_version: "v1",
  pair: PAIR,
  components: [
    {
      kind: "base_image",
      source: `docker.io/library/debian@sha256:${"a".repeat(64)}`,
      sha256: `sha256:${"a".repeat(64)}`,
    },
  ],
} as ComposedEnvironmentRecipe;

const RECIPE_SHA = composedEnvironmentRecipeHash(RECIPE);

function environment(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    environmentId: "env-1",
    cliver: PAIR.cliver,
    rsver: PAIR.rsver,
    templateVersion: "v1",
    status: "composing",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function successReceipt(overrides: Partial<ComposerArtifact> = {}): Record<string, unknown> {
  return {
    schema: "scvs-composer-artifact-v1",
    environment_id: "env-1",
    classification: "success",
    composed_at: "2026-08-06T00:10:00.000Z",
    recipe_sha256: RECIPE_SHA,
    image_digest: IMAGE_DIGEST,
    recipe: RECIPE,
    smoke_test: { reported_cliver: PAIR.cliver, reported_rsver: PAIR.rsver, matches_pair: true },
    ...overrides,
  } as unknown as Record<string, unknown>;
}

class FakeEnvironments {
  ready: Array<{
    id: string;
    recipeSha256: string;
    imageDigest: string;
    recipePersisted: boolean;
    arch?: string;
  }> = [];
  failed: Array<{ id: string; errorCode: string }> = [];
  async markReady(
    environmentId: string,
    input: { recipeSha256: string; imageDigest: string; recipe?: unknown; arch?: string },
  ): Promise<void> {
    this.ready.push({
      id: environmentId,
      recipeSha256: input.recipeSha256,
      imageDigest: input.imageDigest,
      recipePersisted: input.recipe !== undefined,
      arch: input.arch,
    });
  }
  async markFailed(environmentId: string, errorCode: string): Promise<void> {
    this.failed.push({ id: environmentId, errorCode });
  }
}

const config = {
  get: () => ({ bucket: "scvs-staging", region: "eu-west-1" }),
} as unknown as AppConfigService & ConfigService;

function serviceFor(environments: FakeEnvironments) {
  return new EnvironmentOutcomeService(
    config,
    environments as unknown as EnvironmentsRepository,
  );
}

async function record(
  receipt: Record<string, unknown> | undefined,
  row: EnvironmentRecord = environment(),
): Promise<{ environments: FakeEnvironments; outcome: unknown }> {
  getObjectText.mockResolvedValue(receipt ? JSON.stringify(receipt) : undefined);
  const environments = new FakeEnvironments();
  const outcome = await serviceFor(environments).recordFromBatchTerminalState(row, {
    status: "SUCCEEDED",
  });
  return { environments, outcome };
}

beforeEach(() => {
  getObjectText.mockReset();
});

describe("EnvironmentOutcomeService", () => {
  it("records a well-formed success receipt as ready, with both identities", async () => {
    const { environments, outcome } = await record(successReceipt());

    expect(outcome).toEqual({
      status: "ready",
      recipeSha256: RECIPE_SHA,
      imageDigest: IMAGE_DIGEST,
    });
    expect(environments.ready).toEqual([
      {
        id: "env-1",
        recipeSha256: RECIPE_SHA,
        imageDigest: IMAGE_DIGEST,
        recipePersisted: true,
        arch: undefined,
      },
    ]);
    expect(environments.failed).toEqual([]);
  });

  it("synthesises a failure when the composer finished but uploaded no receipt", async () => {
    const { environments, outcome } = await record(undefined);

    expect(outcome).toEqual({
      status: "failed",
      errorCode: "composer_finished_without_receipt",
    });
    expect(environments.failed).toEqual([
      { id: "env-1", errorCode: "composer_finished_without_receipt" },
    ]);
  });

  it("records a declared composition failure under the composer's own reason code", async () => {
    const { environments, outcome } = await record({
      schema: "scvs-composer-artifact-v1",
      environment_id: "env-1",
      classification: "composition_failure",
      composed_at: "2026-08-06T00:10:00.000Z",
      reason: "component_checksum_mismatch",
      failure_context: { component: "rustup", expected: "…", actual: "…" },
    });

    expect(outcome).toEqual({ status: "failed", errorCode: "component_checksum_mismatch" });
    expect(environments.failed).toEqual([
      { id: "env-1", errorCode: "component_checksum_mismatch" },
    ]);
  });

  it("substitutes a generic code for a failure receipt that carries no reason", async () => {
    const { outcome } = await record({
      schema: "scvs-composer-artifact-v1",
      environment_id: "env-1",
      classification: "composition_failure",
      composed_at: "2026-08-06T00:10:00.000Z",
    });
    expect(outcome).toEqual({ status: "failed", errorCode: "composition_failed" });
  });

  it("refuses a receipt written for a different environment", async () => {
    const { outcome } = await record(successReceipt({ environment_id: "env-other" }));
    expect(outcome).toEqual({
      status: "failed",
      errorCode: "composer_receipt_mismatched_environment",
    });
  });

  it("refuses a success receipt missing any one of the three identities", async () => {
    for (const missing of ["recipe_sha256", "image_digest", "recipe"] as const) {
      const receipt = successReceipt();
      delete receipt[missing];
      const { environments, outcome } = await record(receipt);
      expect(outcome).toEqual({ status: "failed", errorCode: "composer_receipt_incomplete" });
      expect(environments.ready).toEqual([]);
    }
  });

  it("refuses a receipt whose recipe describes a different pair than was requested", async () => {
    const otherPair = { ...RECIPE, pair: { cliver: "26.0.0", rsver: "1.94.1" } };
    const { outcome } = await record(
      successReceipt({
        recipe: otherPair as ComposedEnvironmentRecipe,
        recipe_sha256: composedEnvironmentRecipeHash(otherPair as ComposedEnvironmentRecipe),
      }),
    );
    expect(outcome).toEqual({ status: "failed", errorCode: "composer_receipt_wrong_pair" });
  });

  it("refuses a receipt whose recipe was built against a different template version", async () => {
    const otherTemplate = { ...RECIPE, template_version: "v2" };
    const { outcome } = await record(
      successReceipt({
        recipe: otherTemplate as ComposedEnvironmentRecipe,
        recipe_sha256: composedEnvironmentRecipeHash(otherTemplate as ComposedEnvironmentRecipe),
      }),
    );
    expect(outcome).toEqual({ status: "failed", errorCode: "composer_receipt_wrong_pair" });
  });

  it("refuses a recipe_sha256 that does not hash from the recipe beside it", async () => {
    const { environments, outcome } = await record(
      successReceipt({ recipe_sha256: "f".repeat(64) }),
    );
    expect(outcome).toEqual({ status: "failed", errorCode: "composer_recipe_hash_mismatch" });
    expect(environments.ready).toEqual([]);
  });

  it("refuses a success receipt that contradicts itself with a failed smoke test", async () => {
    const { outcome } = await record(
      successReceipt({
        smoke_test: {
          reported_cliver: "26.0.0",
          reported_rsver: "1.94.1",
          matches_pair: false,
        },
      }),
    );
    expect(outcome).toEqual({ status: "failed", errorCode: "composer_smoke_test_disagreed" });
  });

  it("accepts a success receipt with no smoke test at all, rather than inventing a verdict", async () => {
    const receipt = successReceipt();
    delete receipt.smoke_test;
    const { outcome } = await record(receipt);
    expect(outcome).toEqual({
      status: "ready",
      recipeSha256: RECIPE_SHA,
      imageDigest: IMAGE_DIGEST,
    });
  });

  it("tryRecordFromArtifact reports false on a missing receipt instead of recording a failure", async () => {
    getObjectText.mockResolvedValue(undefined);
    const environments = new FakeEnvironments();

    await expect(
      serviceFor(environments).tryRecordFromArtifact(environment()),
    ).resolves.toBe(false);
    expect(environments.failed).toEqual([]);
    expect(environments.ready).toEqual([]);
  });

  it("tryRecordFromArtifact records and reports true when the receipt is there", async () => {
    getObjectText.mockResolvedValue(JSON.stringify(successReceipt()));
    const environments = new FakeEnvironments();

    await expect(serviceFor(environments).tryRecordFromArtifact(environment())).resolves.toBe(true);
    expect(environments.ready).toHaveLength(1);
  });

  it("lets a read failure propagate rather than recording it as an absent receipt", async () => {
    getObjectText.mockRejectedValue(new Error("AccessDenied"));
    const environments = new FakeEnvironments();

    await expect(
      serviceFor(environments).recordFromBatchTerminalState(environment(), { status: "FAILED" }),
    ).rejects.toThrow(/AccessDenied/);
    expect(environments.failed).toEqual([]);
  });

  it("rejects a receipt whose schema string is not the one this service understands", async () => {
    getObjectText.mockResolvedValue(
      JSON.stringify(successReceipt({ schema: "scvs-composer-artifact-v2" as never })),
    );
    const environments = new FakeEnvironments();

    await expect(
      serviceFor(environments).recordFromBatchTerminalState(environment(), { status: "SUCCEEDED" }),
    ).rejects.toThrow();
    expect(environments.ready).toEqual([]);
  });
});

describe("EnvironmentOutcomeService — the architecture the composer reported", () => {
  it("records it on the row", async () => {
    const { environments, outcome } = await record(successReceipt({ image_architecture: "arm64" }));

    expect(outcome).toMatchObject({ status: "ready" });
    expect(environments.ready).toHaveLength(1);
    expect(environments.ready[0]!.arch).toBe("arm64");
    expect(environments.failed).toEqual([]);
  });

  it("records amd64 as readily as arm64", async () => {
    const { environments } = await record(successReceipt({ image_architecture: "amd64" }));

    expect(environments.ready[0]!.arch).toBe("amd64");
  });

  it("still marks the row ready when the receipt reports none", async () => {
    const { environments, outcome } = await record(successReceipt());

    expect(outcome).toMatchObject({ status: "ready" });
    expect(environments.ready[0]!.arch).toBeUndefined();
    expect(environments.failed).toEqual([]);
  });

  it("★ drops an architecture we have no queue for, and still marks the row ready", async () => {
    const { environments, outcome } = await record(
      successReceipt({ image_architecture: "riscv64" }),
    );

    expect(outcome).toMatchObject({ status: "ready" });
    expect(environments.ready[0]!.arch).toBeUndefined();
    expect(environments.failed).toEqual([]);
  });

  it("drops a `uname -m` spelling rather than trusting it", async () => {
    const { environments } = await record(successReceipt({ image_architecture: "aarch64" }));

    expect(environments.ready[0]!.arch).toBeUndefined();
  });
});
