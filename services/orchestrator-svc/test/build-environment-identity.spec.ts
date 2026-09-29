import type {
  BuildEnvironmentResolution,
  ComposeIntent,
  ComposedEnvironmentRecipe,
  MaterializationResult,
  MaterializedEnvironment,
} from "@scvs/core";
import { BuildEnvironmentIdentityService } from "../src/modules/verification-pipeline/build-environment-identity.service.js";
import type { BuildEnvironmentMaterializer } from "../src/modules/build-environments/build-environment-materializer.js";
import type { BuildEnvironmentResolver } from "../src/modules/build-environments/build-environment-resolver.js";
import type { WasmMetadata } from "../src/modules/verification-pipeline/chain-reader.service.js";
import { ConfigurationError } from "../src/config/configuration-error.js";

const PAIR = { cliver: "23.1.0", rsver: "1.90.0" };
const INTENT: ComposeIntent = { pair: PAIR, template_version: "v1" };
const RECIPE_SHA = "a".repeat(64);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const TRUSTED_IMAGE = `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`;
const REPO = "111122223333.dkr.ecr.us-east-1.amazonaws.com/sv-dev-composed-environments";

function metadata(sep58: Record<string, unknown> = {}): WasmMetadata {
  return {
    wasm_hash: "d".repeat(64),
    wasm_byte_size: 1024,
    sep58: { raw_entries: [], ...sep58 },
    toolchain_pair: PAIR,
    diagnostics: { mode: "stellar_cli", fetch: { exit_code: 0, stdout: "", stderr: "" } },
  } as WasmMetadata;
}

class StubResolver implements BuildEnvironmentResolver {
  calls = 0;
  constructor(private readonly answer: BuildEnvironmentResolution) {}
  async resolve(): Promise<BuildEnvironmentResolution> {
    this.calls += 1;
    return this.answer;
  }
}

class StubMaterializer implements BuildEnvironmentMaterializer {
  constructor(
    private readonly answer: MaterializationResult,
    private readonly ready?: MaterializedEnvironment,
  ) {}
  async materialize(): Promise<MaterializationResult> {
    return this.answer;
  }
  async findReadyByRecipeSha256(): Promise<MaterializedEnvironment | undefined> {
    return this.ready;
  }
}

function environment(arch?: "amd64" | "arm64"): MaterializedEnvironment {
  return {
    recipeSha256: RECIPE_SHA,
    imageDigest: IMAGE_DIGEST,
    recipe: {} as ComposedEnvironmentRecipe,
    ...(arch ? { arch } : {}),
  };
}

function service(options: {
  resolution?: BuildEnvironmentResolution;
  materialization?: MaterializationResult;
  ready?: MaterializedEnvironment;
  repositoryUri?: string | undefined;
}): {
  identity: BuildEnvironmentIdentityService;
  resolver: StubResolver;
} {
  const resolver = new StubResolver(
    options.resolution ?? { kind: "compose", intent: INTENT, trustLevel: "upstream_pinned" },
  );
  const materializer = new StubMaterializer(
    options.materialization ?? { kind: "composing", environmentId: "env-1" },
    options.ready,
  );
  const config = {
    get: (key: string) =>
      key === "composedEnvironmentRepositoryUri"
        ? "repositoryUri" in options
          ? options.repositoryUri
          : REPO
        : undefined,
  };
  return {
    identity: new BuildEnvironmentIdentityService(
      config as never,
      resolver,
      materializer,
    ),
    resolver,
  };
}

describe("BuildEnvironmentIdentityService.resolve", () => {
  it("takes a chain-named image the policy accepts, without asking the resolver", async () => {
    const { identity, resolver } = service({});

    const outcome = await identity.resolve("job-1", metadata({ bldimg: TRUSTED_IMAGE }));

    expect(outcome).toEqual({ kind: "resolved", identity: TRUSTED_IMAGE });
    expect(resolver.calls).toBe(0);
  });

  it("fails on a chain-named image the policy rejects, carrying the policy's own reason", async () => {
    const { identity } = service({});

    const outcome = await identity.resolve(
      "job-1",
      metadata({ bldimg: "ghcr.io/someone/else@sha256:" + "e".repeat(64) }),
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toBe("unsupported");
    expect(outcome.reasonCode).toBe("image_not_official_trusted");
    expect(outcome.detail).toBeDefined();
  });

  it("fails when the recorded toolchain cannot be served at all", async () => {
    const { identity } = service({
      resolution: { kind: "unsupported", reason: "unreleased_cli" },
    });

    const outcome = await identity.resolve("job-1", metadata());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "unsupported",
      reasonCode: "unreleased_cli",
      detail: expect.stringContaining("official, released components"),
    });
  });

  it("reports composing as its own outcome, not as a failure", async () => {
    const { identity } = service({
      materialization: { kind: "composing", environmentId: "env-42" },
    });

    const outcome = await identity.resolve("job-1", metadata());

    expect(outcome).toEqual({ kind: "composing", environmentId: "env-42" });
  });

  it("keys the rebuild on the recipe hash once the environment is ready", async () => {
    const { identity } = service({
      materialization: { kind: "ready", environmentId: "env-1", environment: environment() },
    });

    const outcome = await identity.resolve("job-1", metadata());

    expect(outcome).toEqual({ kind: "resolved", identity: RECIPE_SHA });
  });

  it("calls a permanent composition failure policy_rejected", async () => {
    const { identity } = service({
      materialization: { kind: "failed", environmentId: "env-1", errorCode: "component_checksum_mismatch" },
    });

    const outcome = await identity.resolve("job-1", metadata());

    expect(outcome).toMatchObject({ kind: "failed", reason: "policy_rejected", reasonCode: "component_checksum_mismatch" });
  });

  it("calls a composer-side composition failure build_failed", async () => {
    const { identity } = service({
      materialization: { kind: "failed", environmentId: "env-1", errorCode: "internal_error" },
    });

    const outcome = await identity.resolve("job-1", metadata());

    expect(outcome).toMatchObject({ kind: "failed", reason: "build_failed", reasonCode: "internal_error" });
  });
});

describe("BuildEnvironmentIdentityService.resolveImageReference", () => {
  it("passes a chain-named identity straight through, with no architecture to claim", async () => {
    const { identity } = service({});

    expect(await identity.resolveImageReference(TRUSTED_IMAGE)).toEqual({
      pullReference: TRUSTED_IMAGE,
    });
  });

  it("qualifies a composed identity against the configured repository, carrying the stored arch", async () => {
    const { identity } = service({ ready: environment("arm64") });

    expect(await identity.resolveImageReference(RECIPE_SHA)).toEqual({
      pullReference: `${REPO}@${IMAGE_DIGEST}`,
      arch: "arm64",
    });
  });

  it("answers undefined when the environment row behind a keyed rebuild has gone", async () => {
    const { identity } = service({});

    expect(await identity.resolveImageReference(RECIPE_SHA)).toBeUndefined();
  });

  it("refuses to invent a repository when none is configured", async () => {
    const { identity } = service({ ready: environment(), repositoryUri: undefined });

    await expect(identity.resolveImageReference(RECIPE_SHA)).rejects.toThrow(ConfigurationError);
  });
});
