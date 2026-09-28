import { resolveJobVerdict } from "../src/modules/verification-pipeline/verdict.util.js";

const REBUILT = "a".repeat(64);
const OTHER = "b".repeat(64);

const rebuild = (over: Partial<Parameters<typeof resolveJobVerdict>[0]["rebuild"]> = {}) => ({
  rebuiltWasmHash: REBUILT,
  buildMode: "verify" as const,
  mechanismReason: "on_chain_recipe_in_trusted_image" as const,
  diagnostics: undefined,
  ...over,
});

describe("resolveJobVerdict", () => {
  it("verifies when the rebuilt bytes hash to what the target currently deploys", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: REBUILT,
      recordedHash: REBUILT,
    });

    expect(verdict.matched).toBe(true);
    expect(verdict.drifted).toBe(false);
    expect(verdict.result.rebuilt_wasm_hash).toBe(REBUILT);
    expect(verdict.result.wasm_hash).toBe(REBUILT);
    expect(verdict.result.contract_binding_drifted).toBeUndefined();
  });

  it("does not verify when the rebuilt bytes differ from what is deployed", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: OTHER,
      recordedHash: OTHER,
    });

    expect(verdict.matched).toBe(false);
    expect(verdict.drifted).toBe(false);
  });

  it("reports drift, and still verifies, when the contract was upgraded to the rebuilt bytes mid-flight", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: REBUILT,
      recordedHash: OTHER,
    });

    expect(verdict.matched).toBe(true);
    expect(verdict.drifted).toBe(true);
    expect(verdict.result.contract_binding_drifted).toBe(true);
    expect(verdict.result.wasm_hash).toBe(REBUILT);
  });

  it("reports drift on a mismatch too — the two conditions are independent", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: "c".repeat(64),
      recordedHash: OTHER,
    });

    expect(verdict.matched).toBe(false);
    expect(verdict.drifted).toBe(true);
  });

  it("treats a job with no recorded hash as undrifted rather than drifted", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: REBUILT,
      recordedHash: undefined,
    });

    expect(verdict.drifted).toBe(false);
    expect(verdict.matched).toBe(true);
  });

  it("never verifies a rebuild that produced no bytes", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild({ rebuiltWasmHash: undefined }),
      freshDeployedHash: REBUILT,
      recordedHash: REBUILT,
    });

    expect(verdict.matched).toBe(false);
    expect(verdict.result.rebuilt_wasm_hash).toBeUndefined();
  });

  it("compares hashes, not their spelling — an uppercase target hash still verifies", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: REBUILT.toUpperCase(),
      recordedHash: REBUILT.toUpperCase(),
    });

    expect(verdict.matched).toBe(true);
    expect(verdict.drifted).toBe(false);
    expect(verdict.result.wasm_hash).toBe(REBUILT);
    expect(verdict.result.expected_wasm_hash).toBe(REBUILT);
  });

  it("does not report drift from case alone", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: REBUILT,
      recordedHash: REBUILT.toUpperCase(),
    });

    expect(verdict.drifted).toBe(false);
    expect(verdict.matched).toBe(true);
  });

  it("still reports a genuine mismatch when only the case agrees", () => {
    const verdict = resolveJobVerdict({
      rebuild: rebuild(),
      freshDeployedHash: OTHER.toUpperCase(),
      recordedHash: OTHER.toUpperCase(),
    });

    expect(verdict.matched).toBe(false);
    expect(verdict.result.wasm_hash).toBe(OTHER);
  });

  it("labels the verification path from the recipe's provenance, not a hardcoded default", () => {
    expect(
      resolveJobVerdict({
        rebuild: rebuild({ mechanismReason: "on_chain_recipe_in_trusted_image" }),
        freshDeployedHash: REBUILT,
      }).result.verification_path,
    ).toBe("metadata_backed");

    expect(
      resolveJobVerdict({
        rebuild: rebuild({ mechanismReason: "recipe_deviates_from_chain" }),
        freshDeployedHash: REBUILT,
      }).result.verification_path,
    ).toBe("retroactive_manual");
  });

  describe("the burned verify attempt", () => {
    it("★ publishes the demoted attempt's reason, now beside a label that agrees with it", () => {
      const verdict = resolveJobVerdict({
        rebuild: rebuild({
          mechanismReason: "on_chain_recipe_in_trusted_image",
          buildMode: "build",
          verifyFailureCode: "source_archive_not_chain_recorded",
        }),
        freshDeployedHash: REBUILT,
      });

      expect(verdict.result.verification_path).toBe("metadata_backed");
      expect(verdict.result.verify_attempt_reason).toBe("source_archive_not_chain_recorded");
    });

    it("says nothing for a rebuild PA1 routed to the sandbox from the start", () => {
      const verdict = resolveJobVerdict({
        rebuild: rebuild({ mechanismReason: "recipe_deviates_from_chain", buildMode: "build" }),
        freshDeployedHash: REBUILT,
      });

      expect(verdict.result.verification_path).toBe("retroactive_manual");
      expect(verdict.result.verify_attempt_reason).toBeUndefined();
    });
  });

  describe("the source reconstruction", () => {
    const canonicalisation = (over: Record<string, unknown> = {}) => ({
      depth: 0,
      outer_format: "gzip",
      canonical_format: "gzip",
      reconstruction: "hash_mismatch",
      reconstruction_detail: "…and a tree that differs from the one that was built.",
      uploaded: false,
      ...over,
    });

    it("★ forwards the materialiser's own sentence rather than paraphrasing it", () => {
      const verdict = resolveJobVerdict({
        rebuild: rebuild({ sourceCanonicalisation: canonicalisation() }),
        freshDeployedHash: REBUILT,
      });

      expect(verdict.result.source_reconstruction).toEqual({
        outcome: "hash_mismatch",
        detail: "…and a tree that differs from the one that was built.",
      });
    });

    it("publishes an adopted rebuild too — it is why source_sha256 is not the upload's hash", () => {
      const verdict = resolveJobVerdict({
        rebuild: rebuild({
          sourceCanonicalisation: canonicalisation({
            reconstruction: "adopted",
            reconstruction_detail: undefined,
          }),
        }),
        freshDeployedHash: REBUILT,
      });

      expect(verdict.result.source_reconstruction).toEqual({ outcome: "adopted" });
    });

    it.each(["not_attempted", "no_oracle"])(
      "drops %s — a non-event a reader cannot act on",
      (reconstruction) => {
        const verdict = resolveJobVerdict({
          rebuild: rebuild({ sourceCanonicalisation: canonicalisation({ reconstruction }) }),
          freshDeployedHash: REBUILT,
        });

        expect(verdict.result.source_reconstruction).toBeUndefined();
      },
    );

    it("survives a row with no record, and one whose record is not the shape it expects", () => {
      expect(
        resolveJobVerdict({ rebuild: rebuild(), freshDeployedHash: REBUILT }).result
          .source_reconstruction,
      ).toBeUndefined();

      expect(
        resolveJobVerdict({
          rebuild: rebuild({ sourceCanonicalisation: "not an object" }),
          freshDeployedHash: REBUILT,
        }).result.source_reconstruction,
      ).toBeUndefined();
    });
  });
});

describe("verification_path follows the recipe's provenance", () => {
  const verdictFor = (over: Record<string, unknown>) =>
    resolveJobVerdict({
      rebuild: rebuild(over as never),
      freshDeployedHash: REBUILT,
      recordedHash: REBUILT,
    }).result.verification_path;

  it("★ says metadata_backed for the chain's own recipe even though the sandbox ran it", () => {
    expect(
      verdictFor({
        mechanismReason: "on_chain_recipe_in_trusted_image",
        runner: "docker_build_image_rebuild",
      }),
    ).toBe("metadata_backed");
  });

  it("says retroactive_manual for every provenance that is not the chain's own recipe", () => {
    for (const reason of ["no_chain_recorded_image", "environment_is_composed", "recipe_deviates_from_chain"]) {
      expect(verdictFor({ mechanismReason: reason, runner: "docker_build_image_rebuild" })).toBe(
        "retroactive_manual",
      );
    }
  });

  it("groups image_not_policy_accepted with the on-chain case, as recipeSourceFor does", () => {
    expect(verdictFor({ mechanismReason: "image_not_policy_accepted" })).toBe("metadata_backed");
  });

  it("needs no special case for a legacy row that really did run the CLI", () => {
    expect(
      verdictFor({
        mechanismReason: "on_chain_recipe_in_trusted_image",
        buildMode: "verify",
        runner: "stellar_contract_verify",
      }),
    ).toBe("metadata_backed");
  });
});
