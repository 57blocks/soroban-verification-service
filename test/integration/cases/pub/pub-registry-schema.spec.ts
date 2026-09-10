/** A Registry consumer reads `<result-root>/wasms/{hash}.json` instead. */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { submitAndWait } from "../../support/job.js";
import { requireStatusObject } from "../../support/result-tree.js";
import { validateSepStatusObject } from "../../support/status-schema.js";

caseBlock(
  {
    id: "E2E-PUB-03",
    title: "Results SEP 1.0 status object schema conformance (TRD §5.2)",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    let status: unknown;

    beforeAll(async () => {
      const run = await submitAndWait(await submissionFor("F-LEG-1"));
      const wasmHash = run.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash;
      if (!wasmHash) throw new Error("F-LEG-1 has no wasm_hash in the response or fixture inventory");
      // requireStatusObject reads the static result root, never verification-svc or query-svc.
      status = await requireStatusObject(wasmHash);
    }, env.jobTimeoutMs + 120_000);

    it("/sep_schema_valid — the complete static document satisfies the Results SEP schema", () => {
      expect(validateSepStatusObject(status)).toEqual([]);
    });

    it("/no_undeclared_fields — closed objects reject fields the schema does not name", () => {
      const errors = validateSepStatusObject(status);
      expect(errors.filter((error) => error.includes("not declared"))).toEqual([]);
    });

    it("/document_identity — schema and schema_version name exactly the shape published (CV1)", () => {
      expect((status as { schema?: unknown }).schema).toBe("stellar-verification-status");
      expect((status as { schema_version?: unknown }).schema_version).toBe("1.0");
    });
  }
);
