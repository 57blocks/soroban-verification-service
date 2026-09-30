import type {
  CreateEnvironmentInput,
  EnvironmentRecord,
  EnvironmentStatus,
  EnvironmentsRepository,
  MarkEnvironmentReadyInput,
} from "@scvs/db";
import type { ComposeIntent, ComposedEnvironmentRecipe } from "@scvs/core";
import { CachingBuildEnvironmentMaterializer } from "../src/modules/build-environments/caching-build-environment-materializer.service.js";
import type { ComposerDispatchService } from "../src/modules/build-environments/composer-dispatch.service.js";

const PAIR = { cliver: "25.1.0", rsver: "1.95.0" };
const INTENT: ComposeIntent = { pair: PAIR, template_version: "v1" };
const RECIPE_SHA = "a".repeat(64);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const RECIPE = {
  schema: "scvs-composed-environment-v1",
  template_version: "v1",
  pair: PAIR,
  components: [],
} as unknown as ComposedEnvironmentRecipe;

type Seed = Partial<EnvironmentRecord> & { status: EnvironmentStatus };

class FakeEnvironments {
  row: EnvironmentRecord | undefined;
  readonly calls: string[] = [];

  constructor(seed?: Seed) {
    if (seed) this.row = { ...baseRecord(), ...seed };
  }

  async findOrCreate(input: CreateEnvironmentInput): Promise<EnvironmentRecord> {
    this.calls.push("findOrCreate");
    this.row ??= { ...baseRecord(), ...input, status: "pending" };
    return this.row;
  }

  async findByRecipeSha256(recipeSha256: string): Promise<EnvironmentRecord | undefined> {
    this.calls.push("findByRecipeSha256");
    return this.row?.recipeSha256 === recipeSha256 ? this.row : undefined;
  }

  async claimForComposing(environmentId: string): Promise<boolean> {
    this.calls.push("claimForComposing");
    if (!this.row || this.row.environmentId !== environmentId) return false;
    if (this.row.status !== "pending") return false;
    this.row = { ...this.row, status: "composing" };
    return true;
  }

  async releaseClaim(environmentId: string): Promise<void> {
    this.calls.push("releaseClaim");
    if (this.row?.environmentId === environmentId) {
      this.row = { ...this.row, status: "pending" };
    }
  }

  async markReady(environmentId: string, input: MarkEnvironmentReadyInput): Promise<void> {
    this.calls.push("markReady");
    if (this.row?.environmentId === environmentId) {
      this.row = { ...this.row, status: "ready", ...input };
    }
  }
}

function baseRecord(): EnvironmentRecord {
  return {
    environmentId: "env-1",
    cliver: PAIR.cliver,
    rsver: PAIR.rsver,
    templateVersion: "v1",
    status: "pending",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

class FakeComposer {
  submissions = 0;
  error: Error | undefined;
  async submitComposerJob(): Promise<string> {
    this.submissions += 1;
    if (this.error) throw this.error;
    return "batch-job-1";
  }
}

class DenyingMaterializer extends CachingBuildEnvironmentMaterializer {
  protected override readonly deniedImageDigests = [IMAGE_DIGEST];
}

function materializerFor(
  environments: FakeEnvironments,
  composer: FakeComposer = new FakeComposer(),
  Materializer: typeof CachingBuildEnvironmentMaterializer = CachingBuildEnvironmentMaterializer,
): CachingBuildEnvironmentMaterializer {
  return new Materializer(
    environments as unknown as EnvironmentsRepository,
    composer as unknown as ComposerDispatchService,
  );
}

describe("CachingBuildEnvironmentMaterializer", () => {
  it("claims a pending environment and submits exactly one composer job", async () => {
    const environments = new FakeEnvironments();
    const composer = new FakeComposer();

    const result = await materializerFor(environments, composer).materialize(INTENT, "job-1");

    expect(result).toEqual({
      kind: "composing",
      environmentId: environments.row!.environmentId,
    });
    expect(composer.submissions).toBe(1);
    expect(environments.row?.status).toBe("composing");
  });

  it("does not resubmit for a second job attached to the same pair", async () => {
    const environments = new FakeEnvironments();
    const composer = new FakeComposer();
    const materializer = materializerFor(environments, composer);

    const first = await materializer.materialize(INTENT, "job-1");
    const second = await materializer.materialize(INTENT, "job-2");

    expect(second).toEqual({
      kind: "composing",
      environmentId: (first as { environmentId: string }).environmentId,
    });
    expect(composer.submissions).toBe(1);
  });

  it("returns composing for a row someone else already claimed, without touching Batch", async () => {
    const environments = new FakeEnvironments({ status: "composing" });
    const composer = new FakeComposer();

    const result = await materializerFor(environments, composer).materialize(INTENT, "job-1");

    expect(result).toEqual({ kind: "composing", environmentId: "env-1" });
    expect(composer.submissions).toBe(0);
    expect(environments.calls).not.toContain("claimForComposing");
  });

  it("returns the recorded identities for a ready environment, composing nothing", async () => {
    const environments = new FakeEnvironments({
      status: "ready",
      recipeSha256: RECIPE_SHA,
      imageDigest: IMAGE_DIGEST,
      recipe: RECIPE,
    });
    const composer = new FakeComposer();

    const result = await materializerFor(environments, composer).materialize(INTENT, "job-1");

    expect(result).toEqual({
      kind: "ready",
      environmentId: "env-1",
      environment: { recipeSha256: RECIPE_SHA, imageDigest: IMAGE_DIGEST, recipe: RECIPE },
    });
    expect(composer.submissions).toBe(0);
  });

  it("reports a half-recorded ready row as a failure rather than dispatching against it", async () => {
    const environments = new FakeEnvironments({
      status: "ready",
      recipeSha256: RECIPE_SHA,
    });

    const result = await materializerFor(environments).materialize(INTENT, "job-1");

    expect(result).toEqual({
      kind: "failed",
      environmentId: "env-1",
      errorCode: "environment_record_incomplete",
    });
  });

  it("never retries a failed environment automatically, and surfaces its recorded error code", async () => {
    const environments = new FakeEnvironments({ status: "failed", errorCode: "unreleased_cli" });
    const composer = new FakeComposer();

    const result = await materializerFor(environments, composer).materialize(INTENT, "job-1");

    expect(result).toEqual({
      kind: "failed",
      environmentId: "env-1",
      errorCode: "unreleased_cli",
    });
    expect(composer.submissions).toBe(0);
    expect(environments.row?.status).toBe("failed");
  });

  it("substitutes a generic code for a failed row that recorded none", async () => {
    const environments = new FakeEnvironments({ status: "failed" });
    const result = await materializerFor(environments).materialize(INTENT, "job-1");
    expect(result).toEqual({
      kind: "failed",
      environmentId: "env-1",
      errorCode: "environment_composition_failed",
    });
  });

  it("releases the claim when the composer submission throws, so the next tick can retry", async () => {
    const environments = new FakeEnvironments();
    const composer = new FakeComposer();
    composer.error = new Error("SCVS_COMPOSER_JOB_QUEUE_ARN is not configured");

    await expect(
      materializerFor(environments, composer).materialize(INTENT, "job-1"),
    ).rejects.toThrow(/SCVS_COMPOSER_JOB_QUEUE_ARN/);

    expect(environments.row?.status).toBe("pending");
    expect(environments.calls).toContain("releaseClaim");
  });

  it("re-throws the dispatch error rather than reporting a composing state that is not happening", async () => {
    const environments = new FakeEnvironments();
    const composer = new FakeComposer();
    composer.error = new Error("Batch rejected the submission");

    const result = await materializerFor(environments, composer)
      .materialize(INTENT, "job-1")
      .then(() => "resolved")
      .catch(() => "threw");

    expect(result).toBe("threw");
  });

  it("finds a ready environment by recipe hash, which is how dispatch resolves the pull coordinate", async () => {
    const environments = new FakeEnvironments({
      status: "ready",
      recipeSha256: RECIPE_SHA,
      imageDigest: IMAGE_DIGEST,
      recipe: RECIPE,
    });

    await expect(
      materializerFor(environments).findReadyByRecipeSha256(RECIPE_SHA),
    ).resolves.toEqual({ recipeSha256: RECIPE_SHA, imageDigest: IMAGE_DIGEST, recipe: RECIPE });
  });

  it("returns undefined for a recipe hash whose row is no longer ready", async () => {
    const environments = new FakeEnvironments({ status: "pending", recipeSha256: RECIPE_SHA });
    await expect(
      materializerFor(environments).findReadyByRecipeSha256(RECIPE_SHA),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for a recipe hash no environment carries", async () => {
    await expect(
      materializerFor(new FakeEnvironments()).findReadyByRecipeSha256(RECIPE_SHA),
    ).resolves.toBeUndefined();
  });

  it("fails a ready environment whose image digest is denied, composing nothing", async () => {
    const environments = new FakeEnvironments({
      status: "ready",
      recipeSha256: RECIPE_SHA,
      imageDigest: IMAGE_DIGEST,
      recipe: RECIPE,
    });
    const composer = new FakeComposer();

    const result = await materializerFor(environments, composer, DenyingMaterializer).materialize(INTENT, "job-1");

    expect(result).toEqual({
      kind: "failed",
      environmentId: "env-1",
      errorCode: "environment_image_denied",
    });
    expect(composer.submissions).toBe(0);
    expect(environments.row?.status).toBe("ready");
  });

  it("does not hand dispatch a ready environment whose image digest is denied", async () => {
    const environments = new FakeEnvironments({
      status: "ready",
      recipeSha256: RECIPE_SHA,
      imageDigest: IMAGE_DIGEST,
      recipe: RECIPE,
    });
    await expect(
      materializerFor(environments, new FakeComposer(), DenyingMaterializer).findReadyByRecipeSha256(RECIPE_SHA),
    ).resolves.toBeUndefined();
  });
});
