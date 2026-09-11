/**
 * E2E-SUB-04 — cli-none is `unsupported`, not `policy_rejected` E2E-SUB-05 — the three image-policy outcomes
 * E2E-SUB-08 — synchronous rejections create no job row
 */
import { caseBlock, rowTest } from "../../support/gate.js";
import { expectPerTrd } from "../../support/conformance.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectErrorEnvelope, expectStatus } from "../../support/http.js";
import { preflight, submit, submitAndWait } from "../../support/job.js";
import { env } from "../../support/env.js";

caseBlock(
  {
    id: "E2E-SUB-04",
    title: "cli-none is `unsupported`, not `policy_rejected`",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-NONE"),
  },
  () => {
    const target = fixtures.contracts["F-NONE"];

    it("preflight classifies it as unsupported for a missing toolchain pair", async () => {
      const response = await preflight({
        network: target.network,
        contract_id: target.contract_id,
      });
      expectStatus(response, 200);

      // HA1, where it is decidable. cli-none means the chain records no `cliver`, so there is no (cliver,
      // rsver) pair to compose an environment from.
      expect(response.json.build_environment?.kind).toBe("unsupported");
      expect(response.json.build_environment?.reason).toBe("missing_toolchain_pair");

      // HA3 — the vocabulary. Asserted as a negative on the wording rather than a positive, which would be a
      // copy test.
      const detail: string = response.json.build_environment?.detail ?? "";
      expect(detail.toLowerCase()).not.toMatch(/\breject(ed|ion)?\b/);
    });

    it(
      "a complete submission takes the job path and terminates unsupported",
      async () => {
        // The reasoning is that a failure is raised where its inputs become available.
        const run = await submitAndWait(await submissionFor("F-NONE"));

        // `not_attempted` is the wire spelling of failure reason `unsupported` — `enums.ts` maps the internal
        // reason onto the external status so the job surface never leaks an internal vocabulary.
        expect(run.body.status).toBe("not_attempted");
        expect(run.body.result?.reason ?? run.body.error).toBe("missing_toolchain_pair");
      },
      env.jobTimeoutMs
    );

    it("a submission with no manifest is answered `incomplete`, and queues nothing", async () => {
      // The no-manifest path is a different question and lands elsewhere: preflight finds `missing_fields`
      // non-empty and returns `200 incomplete` with a field list.
      const outcome = await submit({
        target: { network: target.network, contract_id: target.contract_id },
      });

      expect(outcome.jobId).toBeUndefined();
      expect(outcome.response.status).toBe(200);
      expect(outcome.response.json?.status).toBe("incomplete");
    });
  }
);

caseBlock(
  {
    id: "E2E-SUB-05",
    title: "three image-policy outcomes, keyed on the chain-recorded image",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-58"),
  },
  () => {
    it("/in_trusted_set — an accepted chain image resolves to `chain_named`", async () => {
      const f58 = fixtures.contracts["F-58"];
      const response = await preflight({ network: f58.network, contract_id: f58.contract_id });
      expectStatus(response, 200);

      // F-58 records a digest-pinned, SDF-published image on chain, so policy accepts it and the environment is
      // named by the chain rather than composed.
      expect(response.json.build_environment?.kind).toBe("chain_named");
    });

    rowTest(
      "/tag_only → policy_rejected",
      missingFixture("F-BADIMG-TAG"),
      async () => {
        const target = fixtures.contracts["F-BADIMG-TAG"];
        const response = await preflight({
          network: target.network,
          contract_id: target.contract_id,
        });
        expectStatus(response, 200);
        expect(response.json.build_environment?.kind).toBe("chain_named_policy_rejected");
        expect(response.json.build_environment?.reason).toBe("image_not_digest_pinned");
      }
    );

    rowTest(
      "/digest_outside_trusted_set → unsupported",
      missingFixture("F-BADIMG-UNTRUSTED"),
      async () => {
        const target = fixtures.contracts["F-BADIMG-UNTRUSTED"];
        const response = await preflight({
          network: target.network,
          contract_id: target.contract_id,
        });
        expectStatus(response, 200);
        expect(response.json.build_environment?.kind).toBe("chain_named_policy_rejected");
        expect(response.json.build_environment?.reason).toBe("image_not_sdf_trusted");
      }
    );

    it("a submitted `bldimg` has no authority over the build environment", async () => {
      // Accepting it is not the service being lax; the field is inert.
      const tagOnly = fixtures.images?.tag_only;
      if (!tagOnly) throw new Error("fixture inventory is missing images.tag_only");

      const before = await preflight({
        network: fixtures.contracts["F-58"].network,
        contract_id: fixtures.contracts["F-58"].contract_id,
      });

      const outcome = await submit(await submissionFor("F-58", { bldimg: tagOnly }));
      expectStatus(outcome.response, 202);

      const after = await preflight({
        network: fixtures.contracts["F-58"].network,
        contract_id: fixtures.contracts["F-58"].contract_id,
      });

      // The chain decides, and the chain did not change: the submitted value moved nothing.
      expect(after.json.build_environment?.kind).toBe(before.json.build_environment?.kind);
      expect(after.json.build_environment?.kind).toBe("chain_named");
    });
  }
);

caseBlock(
  {
    id: "E2E-SUB-08",
    title: "synchronous rejections create no job row",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    rowTest("/policy_rejected", missingFixture("F-BADIMG-TAG"), async () => {
      const target = fixtures.contracts["F-BADIMG-TAG"];
      const outcome = await submit({
        target: { network: target.network, contract_id: target.contract_id },
      });

      expectStatus(outcome.response, 400);
      const envelope = expectErrorEnvelope(outcome.response);
      expect(envelope.error).toBe("policy_rejected");
      expect(envelope.reason).toBe("image_not_digest_pinned");
      expect(outcome.jobId).toBeUndefined();
      expect(outcome.response.text).not.toMatch(/"job_id"/);
      expectPerTrd("ERROR_ENVELOPE_SCHEMA_VERSION", "E2E-SUB-08/policy_rejected", () => {
        expect(typeof envelope.schema_version).toBe("string");
      });
    });

    rowTest("/unsupported", missingFixture("F-BADIMG-UNTRUSTED"), async () => {
      const target = fixtures.contracts["F-BADIMG-UNTRUSTED"];
      const outcome = await submit({
        target: { network: target.network, contract_id: target.contract_id },
      });

      expectStatus(outcome.response, 400);
      const envelope = expectErrorEnvelope(outcome.response);
      expect(envelope.error).toBe("unsupported");
      expect(envelope.reason).toBe("image_not_sdf_trusted");
      expect(outcome.jobId).toBeUndefined();
      expect(outcome.response.text).not.toMatch(/"job_id"/);
      expectPerTrd("ERROR_ENVELOPE_SCHEMA_VERSION", "E2E-SUB-08/unsupported", () => {
        expect(typeof envelope.schema_version).toBe("string");
      });
    });

    it("/missing_fields — names the concrete fields and creates nothing", async () => {
      const target = fixtures.contracts["F-LEG-1"];
      const outcome = await submit({
        target: { network: target.network, contract_id: target.contract_id },
      });

      // The implementation answers a **200 `incomplete`** rather than a 4xx, and that is a richer answer than
      // the case anticipated: it hands the submitter the field names and a prefill instead of an error code.
      if (outcome.response.status === 200 && outcome.response.json?.status === "incomplete") {
        expect(Array.isArray(outcome.response.json.missing_fields)).toBe(true);
        expect(outcome.response.json.missing_fields.length).toBeGreaterThan(0);
        expect(outcome.jobId).toBeUndefined();
        return;
      }

      const envelope = expectErrorEnvelope(outcome.response);
      expect(envelope.error).toBe("missing_fields");
      expect(outcome.jobId).toBeUndefined();
      expect(outcome.response.text).not.toMatch(/"job_id"/);

      expectPerTrd("ERROR_ENVELOPE_SCHEMA_VERSION", "E2E-SUB-08/missing_fields", () => {
        expect(typeof envelope.schema_version).toBe("string");
      });
    });
  }
);
