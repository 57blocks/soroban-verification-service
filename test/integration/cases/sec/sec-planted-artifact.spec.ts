import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { readJobLog, submitAndWait } from "../../support/job.js";
import { readReportByUrl } from "../../support/result-tree.js";

const NOT_VERIFIED = ["mismatch", "mismatched", "build_failed", "policy_rejected", "not_attempted"];

caseBlock(
  {
    id: "E2E-SEC-01",
    title: "a `.wasm` shipped in the archive is never selected as rebuilt output",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-ADV-PLANT"),
  },
  () => {
    it(
      "★ never returns `verified` for a source whose real output differs from the planted bytes",
      async () => {
        const target = fixtures.contracts["F-ADV-PLANT"];
        const run = await submitAndWait(await submissionFor("F-ADV-PLANT"));

        expect(NOT_VERIFIED).toContain(run.body.status);
        expect(run.body.status).not.toBe("verified");

        const wasmHash = run.body.result?.wasm_hash ?? target.wasm_hash!;
        const artifactUrl = run.body.result?.artifact_url;
        if (artifactUrl) {
          const report = await readReportByUrl(artifactUrl);
          expect(report.artifact.result.matched).toBe(false);
          expect(report.artifact.result.rebuilt_wasm_hash).not.toBe(wasmHash);
        }

        const log = await readJobLog(run.jobId);
        if (log.ok && log.text) {
          expect(log.text).not.toMatch(/selected.*planted_target\.wasm/i);
        }
      },
      env.jobTimeoutMs + 60_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SEC-02",
    title: "a `.wasm` written by `build.rs` during the build is never selected either",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-ADV-BUILDRS"),
  },
  () => {
    it(
      "★ never returns `verified`, and the run is only meaningful if the plant actually happened",
      async () => {
        const target = fixtures.contracts["F-ADV-BUILDRS"];
        const run = await submitAndWait(await submissionFor("F-ADV-BUILDRS"));

        const log = await readJobLog(run.jobId);
        if (!log.ok || log.text.length === 0) {
          throw new Error(
            `F-ADV-BUILDRS: no build log to read (GET …/log returned ${log.status}). The plant cannot be ` +
              "confirmed, so this run proves nothing about AR1 and must not be read as a pass.",
          );
        }
        if (!/\[F-ADV-BUILDRS\] plant result=Ok/.test(log.text)) {
          const observed = log.text.match(/\[F-ADV-BUILDRS\][^\n]*/g)?.join(" | ") ?? "(no marker in log)";
          throw new Error(
            "F-ADV-BUILDRS did not plant: the build log carries no `plant result=Ok`. This run proves " +
              "nothing about AR1 and must not be read as a pass — regenerate the fixture and confirm the " +
              `plant path against the image's real artifact directory. Observed: ${observed}`,
          );
        }

        expect(NOT_VERIFIED).toContain(run.body.status);
        expect(run.body.status).not.toBe("verified");

        expect(log.text).not.toMatch(/selected.*planted_from_build_rs\.wasm/i);

        const wasmHash = run.body.result?.wasm_hash ?? target.wasm_hash!;
        const artifactUrl = run.body.result?.artifact_url;
        if (artifactUrl) {
          const report = await readReportByUrl(artifactUrl);
          expect(report.artifact.result.matched).toBe(false);
          expect(report.artifact.result.rebuilt_wasm_hash).not.toBe(wasmHash);
        }
      },
      env.jobTimeoutMs + 60_000
    );
  }
);
