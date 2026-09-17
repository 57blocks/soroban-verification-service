import "reflect-metadata";
import { composedEnvironmentRecipeHash, parseDto, RegistryVerification, type ComposedEnvironmentRecipe, type MechanismReason } from "@scvs/core";
import type { JobRecord } from "@scvs/db";
import { assembleArtifact, observeSep55Marker, recipeSourceFor, toBldopt } from "../src/modules/publish/artifact-builder.util.js";
import { PublishService } from "../src/modules/publish/publish.service.js";

/**
 * The cheapest entry that can legally CARRY a `bldopt`. It has to bear a verdict: SO3 closes an `unverified`
 * entry to exactly {verifier, status}, so the four verdict-conditional fields come along with it.
 */
const bldoptCarrier = (bldopt: string[]): Record<string, unknown> => ({
  verifier: { url: "https://v.example/" },
  status: "verified",
  recipe_source: "submitted",
  image_trust_level: "sdf_trusted",
  source_sha256: "a".repeat(64),
  processed_at: "2026-09-09T00:00:00Z",
  bldopt,
});

const recipe: ComposedEnvironmentRecipe = {
  schema: "scvs-composed-environment-v1",
  pair: {
    cliver: `27.0.0#${"a".repeat(40)}`,
    rsver: "1.96.0",
  },
  template_version: "v1",
  components: [
    {
      kind: "base_image",
      source: "docker.io/library/buildpack-deps",
      sha256: `sha256:${"b".repeat(64)}`,
    },
    {
      kind: "rust_toolchain",
      source: "https://static.rust-lang.org/dist/channel-rust-1.96.0.toml",
      sha256: `sha256:${"c".repeat(64)}`,
    },
    {
      kind: "stellar_cli",
      source: "https://github.com/stellar/stellar-cli/releases/download/v27.0.0/stellar.tar.gz",
      sha256: `sha256:${"d".repeat(64)}`,
    },
  ],
};

const job: JobRecord = {
  jobId: "11111111-1111-1111-1111-111111111111",
  status: "comparing",
  failureReason: null,
  target: { network: "testnet", wasm_hash: "1".repeat(64) },
  verificationMode: "submitted",
  sourceRef: {
    type: "source_uri",
    visibility: "public",
    source_uri: "https://example.com/source.tar.gz",
    source_sha256: "2".repeat(64),
  },
  buildOptions: { bldarg: ["contract", "build"], bldopt: ["--locked"] },
  result: {
    status_summary: "verified",
    wasm_hash: "1".repeat(64),
    rebuilt_wasm_hash: "1".repeat(64),
    matched: true,
    verified_at: "2026-08-07T00:00:00.000Z",
  },
  publishAttempts: 0,
  archiveAttempts: 0,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

const CHAIN_IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;

/** Before, it was the hash of the bytes the submitter handed us. */
describe("source.source_sha256 is the archive this verification was produced from", () => {
  const CANONICAL_SHA = "7".repeat(64);

  it("publishes the canonical archive's hash when one was established", () => {
    const artifact = assembleArtifact(
      job,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: CHAIN_IMAGE },
      `${CANONICAL_SHA}.tar.gz`,
      "on_chain_recipe_in_trusted_image",
      CANONICAL_SHA,
    );

    expect(artifact.source.source_sha256).toBe(CANONICAL_SHA);
    expect(artifact.source.source_sha256).not.toBe(job.sourceRef.source_sha256);
    // The pair moves together or the content-addressing breaks.
    expect(artifact.source.source_file_name).toBe(`${CANONICAL_SHA}.tar.gz`);
  });

  it("falls back to the submitted hash when nothing was peeled or rebuilt", () => {
    // Every submission that exists today. Absence of the argument means "they are the same archive", never "we
    // do not know" — which is why this stays the submitted, already-cross-checked value.
    const artifact = assembleArtifact(
      job,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: CHAIN_IMAGE },
      undefined,
      "on_chain_recipe_in_trusted_image",
    );

    expect(artifact.source.source_sha256).toBe(job.sourceRef.source_sha256);
  });
});

/**
 * Its report published `source_sha256: 0f8d9f81…` for a contract recording `3ee9dbfe…` and said nothing about
 * the difference, so the document read as internally consistent while failing this feature's own assertion:
 * whenever the deployed Wasm records a `source_sha256`, either the published value equals it or the verifier
 * does not claim it does.
 */
describe("source.chain_source_sha256", () => {
  const CHAIN_SHA = "3".repeat(64);

  const artifactWith = (chainSourceSha256?: string) =>
    assembleArtifact(
      job,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: CHAIN_IMAGE },
      undefined,
      "on_chain_recipe_in_trusted_image",
      undefined,
      chainSourceSha256,
    );

  it("★ publishes the chain-recorded hash next to the one this verification used", () => {
    const artifact = artifactWith(CHAIN_SHA);

    expect(artifact.source.chain_source_sha256).toBe(CHAIN_SHA);
    // The pair that was unreadable before: what we built from, and what the chain names.
    expect(artifact.source.source_sha256).not.toBe(CHAIN_SHA);
  });

  it("omits it for a contract that records none — there is nothing to compare against", () => {
    expect(artifactWith(undefined).source.chain_source_sha256).toBeUndefined();
  });

  it("★ carries ACN-9's reason and ACN-7's sentence onto the published document", () => {
    // `parseDto` validates and whitelists the artifact, so a field `verdict.util.ts` sets can still be stripped
    // here — this is the round trip that proves both reach the file a submitter reads.
    const artifact = assembleArtifact(
      {
        ...job,
        result: {
          ...job.result!,
          verification_path: "retroactive_manual",
          verify_attempt_reason: "source_archive_not_chain_recorded",
          source_reconstruction: { outcome: "hash_mismatch", detail: "…a missing `.gitignore`." },
        },
      },
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: CHAIN_IMAGE },
      undefined,
      "on_chain_recipe_in_trusted_image",
      undefined,
      CHAIN_SHA,
    );

    expect(artifact.result.verify_attempt_reason).toBe("source_archive_not_chain_recorded");
    expect(artifact.result.source_reconstruction).toEqual({
      outcome: "hash_mismatch",
      detail: "…a missing `.gitignore`.",
    });
    // The three fields that were contradictory on their own, now readable together.
    expect(artifact.provenance.recipe_source).toBe("on_chain_metadata");
    expect(artifact.result.verification_path).toBe("retroactive_manual");
    expect(artifact.source.chain_source_sha256).toBe(CHAIN_SHA);
  });
});

describe("published build-environment evidence", () => {
  it("publishes the actual composed recipe and ECR digest", () => {
    const imageDigest = `sha256:${"e".repeat(64)}`;
    const imageReference = `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@${imageDigest}`;
    const recipeSha256 = "f".repeat(64);

    const artifact = assembleArtifact(
      job,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      {
        kind: "composed",
        trustLevel: "upstream_pinned",
        buildImage: imageReference,
        recipeSha256,
        imageDigest,
        recipe,
      },
      undefined,
      "environment_is_composed",
    );

    expect(artifact.build_recipe).toMatchObject({
      build_image: imageReference,
      build_environment: {
        kind: "composed",
        trust_level: "upstream_pinned",
        recipe_sha256: recipeSha256,
        image_digest: imageDigest,
        image_reference: imageReference,
        recipe,
      },
    });
  });

  it("omits the raw verify command from result.sandbox_diagnostics, the sole published copy (S22)", () => {
    const presignedSourceUri = "https://scvs-staging.s3.amazonaws.com/staging/uploads/some-id/source.tar.gz?X-Amz-Signature=abc123";
    const jobWithDiagnostics: JobRecord = {
      ...job,
      result: {
        ...job.result!,
        sandbox_diagnostics: {
          runner: "stellar_contract_verify",
          command: [
            "stellar",
            "contract",
            "verify",
            "--network",
            "testnet",
            "--wasm-hash",
            "1".repeat(64),
            "--source-uri",
            presignedSourceUri,
            "--trust",
          ],
          command_summary: `stellar contract verify --network testnet --wasm-hash ${"1".repeat(64)} --source-uri ${presignedSourceUri} --trust`,
          build_image: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a"),
        },
      },
    };

    const artifact = assembleArtifact(
      jobWithDiagnostics,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "cli_managed",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a") },
      undefined,
      "on_chain_recipe_in_trusted_image",
    );

    // `parseDto` runs the assembled artifact through `plainToInstance`, which gives every `@IsOptional()` field
    // on `SandboxDiagnostics` an own key with value `undefined` regardless of what the input carried.
    expect(artifact.result.sandbox_diagnostics?.command).toBeUndefined();
    expect(artifact.result.sandbox_diagnostics?.command_summary).toBeUndefined();
    // Every other field survives — this is an omission, not a wholesale strip.
    expect(artifact.result.sandbox_diagnostics).toMatchObject({
      runner: "stellar_contract_verify",
      build_image: expect.any(String),
    });

    // The wire-format check that actually matters: neither field's *bytes* reach the artifact.
    expect(JSON.stringify(artifact)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(artifact)).not.toContain("--source-uri");
    expect(JSON.stringify(artifact)).not.toContain("--wasm-hash");
  });

  it("resolves a cli-legacy Rebuild recipe hash through the ready Environment row", async () => {
    const recipeSha256 = composedEnvironmentRecipeHash(recipe);
    const imageDigest = `sha256:${"e".repeat(64)}`;
    const repository = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments";
    const service = new PublishService(
      { get: (key: string) => (key === "composedEnvironmentRepositoryUri" ? repository : undefined) } as never,
      {} as never,
      {} as never,
      {
        getById: async () => ({
          rebuildId: "22222222-2222-2222-2222-222222222222",
          idempotencyKey: "3".repeat(64),
          sourceRef: job.sourceRef,
          buildOptions: job.buildOptions,
          imageDigest: recipeSha256,
          status: "done",
          buildMode: "build",
          mechanismReason: "environment_is_composed",
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        }),
      } as never,
      {
        findByRecipeSha256: async () => ({
          environmentId: "33333333-3333-3333-3333-333333333333",
          cliver: recipe.pair.cliver,
          rsver: recipe.pair.rsver,
          templateVersion: recipe.template_version,
          status: "ready",
          recipeSha256,
          imageDigest,
          recipe,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        }),
      } as never,
    );

    const context = await (
      service as unknown as {
        resolveBuildContext(value: JobRecord): Promise<{
          buildMode: string;
          mechanismReason: string;
          buildEnvironment: { buildImage: string; recipeSha256: string };
        }>;
      }
    ).resolveBuildContext({ ...job, rebuildId: "22222222-2222-2222-2222-222222222222" });

    expect(context).toMatchObject({
      buildMode: "build",
      mechanismReason: "environment_is_composed",
      buildEnvironment: {
        kind: "composed",
        trustLevel: "upstream_pinned",
        recipeSha256,
        imageDigest,
        buildImage: `${repository}@${imageDigest}`,
        recipe,
      },
    });
  });

  it("refuses to publish any job with no rebuild, including a metadata-mode one", async () => {
    const service = new PublishService(
      {} as never,
      {} as never,
      {} as never,
      { getById: async () => undefined } as never,
      {} as never,
    );

    await expect(
      (
        service as unknown as {
          resolveBuildContext(value: JobRecord): Promise<unknown>;
        }
      ).resolveBuildContext({
        ...job,
        verificationMode: "metadata",
      }),
    ).rejects.toThrow(/no rebuild environment identity/);
  });
});

describe("ArtifactSource.source_uri is not gated on is_public (follow-up)", () => {
  it("publishes source_uri for a private submission that declared one", () => {
    const privateJobWithUri: JobRecord = {
      ...job,
      sourceRef: {
        type: "source_uri",
        visibility: "private",
        source_uri: "https://example.com/private-source.tar.gz",
        source_sha256: "3".repeat(64),
      },
    };

    const artifact = assembleArtifact(
      privateJobWithUri,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a") },
      undefined,
      "recipe_deviates_from_chain",
    );

    expect(artifact.source.is_public).toBe(false);
    expect(artifact.source.source_file_name).toBeUndefined();
    expect(artifact.source.source_uri).toBe("https://example.com/private-source.tar.gz");
  });

  it("omits source_uri for a private submission that never declared one (e.g. an upload_id-only manifest)", () => {
    const privateJobNoUri: JobRecord = {
      ...job,
      sourceRef: {
        type: "private_tarball",
        visibility: "private",
        upload_id: "11111111-1111-1111-1111-111111111111",
        tarball_sha256: "3".repeat(64),
        source_sha256: "3".repeat(64),
      },
    };

    const artifact = assembleArtifact(
      privateJobNoUri,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a") },
      undefined,
      "recipe_deviates_from_chain",
    );

    expect(artifact.source.is_public).toBe(false);
    expect(artifact.source.source_uri).toBeUndefined();
  });
});

describe("recipeSourceFor", () => {
  const cases: Array<[MechanismReason, "on_chain_metadata" | "submitted"]> = [
    ["on_chain_recipe_in_trusted_image", "on_chain_metadata"],
    ["image_not_policy_accepted", "on_chain_metadata"],
    ["no_chain_recorded_image", "submitted"],
    ["environment_is_composed", "submitted"],
    ["recipe_deviates_from_chain", "submitted"],
  ];

  it.each(cases)("%s -> %s", (reason, expected) => {
    expect(recipeSourceFor(reason)).toBe(expected);
  });

  it("publishes on_chain_metadata for a cli-58 private upload whose recipe matches the chain, despite verificationMode: submitted", () => {
    const privateUploadJob: JobRecord = {
      ...job,
      verificationMode: "submitted",
      sourceRef: {
        type: "private_tarball",
        visibility: "private",
        upload_id: "11111111-1111-1111-1111-111111111111",
        tarball_sha256: "2".repeat(64),
        source_sha256: "2".repeat(64),
      },
    };

    const artifact = assembleArtifact(
      privateUploadJob,
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "cli_managed",
      {
        kind: "chain_named",
        trustLevel: "sdf_trusted",
        buildImage: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a"),
      },
      undefined,
      "on_chain_recipe_in_trusted_image",
    );

    expect(artifact.provenance.recipe_source).toBe("on_chain_metadata");
    expect(artifact.provenance.build_isolation).toBe("cli_managed");
  });
});

describe("toBldopt (SO5)", () => {
  // The one shape RegistryVerification.bldopt actually requires: pass each normalised entry through the real
  // validator, not just this file's own expectations of what "correct" looks like.
  const validates = (bldopt: string[]): void => {
    expect(() => parseDto(RegistryVerification, bldoptCarrier(bldopt))).not.toThrow();
  };

  it("merges the short flag -p into --package=value", () => {
    const result = toBldopt({ bldopt: ["-p", "contract-a"] });
    expect(result).toEqual(["--package=contract-a"]);
    validates(result!);
  });

  it("merges a long flag split across two tokens into one --flag=value entry", () => {
    const result = toBldopt({ bldopt: ["--features", "x"] });
    expect(result).toEqual(["--features=x"]);
    validates(result!);
  });

  it("leaves an already-conformant --flag=value entry unchanged (idempotent)", () => {
    const result = toBldopt({ bldopt: ["--features=x"] });
    expect(result).toEqual(["--features=x"]);
    validates(result!);
  });

  it("leaves a bare boolean flag unchanged", () => {
    const result = toBldopt({ bldopt: ["--locked"] });
    expect(result).toEqual(["--locked"]);
    validates(result!);
  });

  it("handles a mix of short, split-long, inline, and boolean flags in one array", () => {
    const result = toBldopt({
      bldopt: ["--manifest-path=contracts/Cargo.toml", "-p", "contract-a", "--locked", "--features", "x"],
    });
    expect(result).toEqual([
      "--manifest-path=contracts/Cargo.toml",
      "--package=contract-a",
      "--locked",
      "--features=x",
    ]);
    validates(result!);
  });

  it("returns undefined when no bldopt is recorded", () => {
    expect(toBldopt({})).toBeUndefined();
    expect(toBldopt(undefined)).toBeUndefined();
  });

  it("does not mutate the recipe's own build_recipe.build_options (recipe stays verbatim)", () => {
    const buildOptions = { bldopt: ["-p", "contract-a"] };
    const artifact = assembleArtifact(
      { ...job, buildOptions },
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "cli_managed",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a") },
      undefined,
      "on_chain_recipe_in_trusted_image",
    );
    expect((artifact.build_recipe?.build_options as { bldopt?: string[] })?.bldopt).toEqual(["-p", "contract-a"]);
  });
});

describe("observeSep55Marker (RA5)", () => {
  // The prefix is the discriminator against legacy SEP-58 v0.4.0 vocabulary — an unprefixed source_repo, or one
  // that merely contains "github:" without being prefixed by it, must read false.
  const cases: Array<[string, unknown, boolean]> = [
    [
      "github: prefix -> true",
      { metadata_replay: ["source_repo=github:example/contract"] },
      true,
    ],
    [
      "ordinary URL -> false",
      { metadata_replay: ["source_repo=https://example.com/src.tar.gz"] },
      false,
    ],
    [
      "contains github: but not as a prefix -> false",
      { metadata_replay: ["source_repo=https://mirror.example.com/github:foo"] },
      false,
    ],
    [
      "uppercase GitHub: prefix -> false",
      { metadata_replay: ["source_repo=GitHub:example/contract"] },
      false,
    ],
    ["empty github: suffix -> true", { metadata_replay: ["source_repo=github:"] }, true],
    ["metadata_replay absent -> false", {}, false],
    ["metadata_replay undefined buildOptions -> false", undefined, false],
    ["metadata_replay empty array -> false", { metadata_replay: [] }, false],
    [
      "metadata_replay present with no source_repo entry -> false",
      { metadata_replay: ["cliver=27.0.0", "bldimg=docker.io/stellar/stellar-cli@sha256:aa"] },
      false,
    ],
    [
      // source_repo is not deduplicated by planMetadataReplay (unlike bldimg/source_uri/ source_sha256), so a
      // section can legally carry more than one entry.
      "a non-matching source_repo entry before a github:-prefixed one -> true",
      {
        metadata_replay: [
          "source_repo=https://mirror.example.com/decoy",
          "source_repo=github:real/repo",
        ],
      },
      true,
    ],
    [
      "a source_repo value containing a second = still splits on the first only -> true",
      { metadata_replay: ["source_repo=github:example/contract?ref=main"] },
      true,
    ],
  ];

  it.each(cases)("%s", (_label, buildOptions, expected) => {
    expect(observeSep55Marker(buildOptions)).toBe(expected);
  });

  it("is wired into assembleArtifact's trust.sep55_attestation_present, and only there", () => {
    const artifact = assembleArtifact(
      { ...job, buildOptions: { metadata_replay: ["source_repo=github:example/contract"] } },
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "cli_managed",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a") },
      undefined,
      "on_chain_recipe_in_trusted_image",
    );

    expect(artifact.trust.sep55_attestation_present).toBe(true);
    // Guards against a leak through build_recipe.build_options, the one field on `PublishedBuildRecipe` still a
    // loose passthrough bag.
    expect(JSON.stringify(artifact)).not.toContain("source_code_verifications");
  });

  it("reads false when the deployed contract's metadata has no github: source_repo", () => {
    const artifact = assembleArtifact(
      { ...job, buildOptions: { bldarg: ["contract", "build"], bldopt: ["--locked"] } },
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "cli_managed",
      { kind: "chain_named", trustLevel: "sdf_trusted", buildImage: "docker.io/stellar/stellar-cli@sha256:aa".padEnd(71, "a") },
      undefined,
      "on_chain_recipe_in_trusted_image",
    );

    expect(artifact.trust.sep55_attestation_present).toBe(false);
  });
});

describe("internal env values in published bldopt", () => {
  const composeEnvironment = (): Parameters<typeof assembleArtifact>[3] => ({
    kind: "composed",
    trustLevel: "upstream_pinned",
    buildImage: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:${"e".repeat(64)}`,
    recipeSha256: "f".repeat(64),
    imageDigest: `sha256:${"e".repeat(64)}`,
    recipe,
  });

  it("redacts the value of an internal --env=SCVS_* bldopt entry, keeping the flag name", () => {
    const scope = "780b281a50f9bcb8e24feb3a";
    const artifact = assembleArtifact(
      {
        ...job,
        buildOptions: { bldarg: ["contract", "build"], bldopt: ["--locked", `--env=SCVS_E2E_RECIPE_SCOPE=${scope}`] },
      },
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      composeEnvironment(),
      undefined,
      "environment_is_composed",
    );

    const bldopt = (artifact.build_recipe?.build_options as { bldopt?: string[] })?.bldopt;
    expect(bldopt).toContain("--env=SCVS_E2E_RECIPE_SCOPE=<redacted>");
    expect(bldopt).not.toContain(`--env=SCVS_E2E_RECIPE_SCOPE=${scope}`);
    expect(bldopt).toContain("--locked");
    expect(JSON.stringify(artifact)).not.toContain(scope);
  });

  it("scrubs the Registry-facing bldopt the same way (toBldopt)", () => {
    const result = toBldopt({ bldopt: ["--locked", "--env=SCVS_E2E_RECIPE_SCOPE=caller-value"] });

    expect(result).toEqual(["--locked", "--env=SCVS_E2E_RECIPE_SCOPE=<redacted>"]);
    // The scrub must not break RegistryVerification.bldopt's own shape check.
    expect(() => parseDto(RegistryVerification, bldoptCarrier(result!))).not.toThrow();
  });

  it("publishes a submitter's own --env entry verbatim", () => {
    const artifact = assembleArtifact(
      { ...job, buildOptions: { bldarg: ["contract", "build"], bldopt: ["--env=MY_PUBLIC_FLAG=keepme"] } },
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      composeEnvironment(),
      undefined,
      "environment_is_composed",
    );

    expect((artifact.build_recipe?.build_options as { bldopt?: string[] })?.bldopt).toContain(
      "--env=MY_PUBLIC_FLAG=keepme",
    );
  });

  it("passes a buildOptions record with no bldopt through untouched", () => {
    const artifact = assembleArtifact(
      { ...job, buildOptions: { bldarg: ["contract", "build"] } },
      { id: "dev-verifier", displayName: "Dev verifier", policyId: "default" },
      "network_isolated",
      composeEnvironment(),
      undefined,
      "environment_is_composed",
    );

    expect(artifact.build_recipe?.build_options).toEqual({ bldarg: ["contract", "build"] });
  });
});
