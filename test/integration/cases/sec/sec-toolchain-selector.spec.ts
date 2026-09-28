import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixture, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus } from "../../support/http.js";
import { readJobLog, submitAndWait } from "../../support/job.js";
import { assertBuildLogRedacted } from "../../support/log-assertions.js";

const SOURCE_REQUESTED_TOOLCHAIN = "1.99.0";

function requiredString(diagnostics: Record<string, unknown>, field: string): string {
  const value = diagnostics[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `E2E-SEC-06 requires sandbox_diagnostics.${field} from the completed rebuild; received ${JSON.stringify(value)}.`
    );
  }
  return value;
}

caseBlock(
  {
    id: "E2E-SEC-06",
    title: "a source rust-toolchain.toml cannot replace the digest-pinned image toolchain",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-ADV-TOOLCHAIN"),
  },
  () => {
    it(
      "pins the image-probed toolchain in the rebuild and never attempts the source-requested version",
      async () => {
        const target = fixture("F-ADV-TOOLCHAIN");
        const run = await submitAndWait(await submissionFor(target.id));

        expect(["verified", "mismatch"]).toContain(run.body.status);

        const diagnostics = run.body.result?.sandbox_diagnostics;
        if (!diagnostics) {
          throw new Error("E2E-SEC-06 completed without sandbox diagnostics; effective toolchain is unobservable.");
        }
        expect(diagnostics.source_rust_toolchain_file).toBe("rust-toolchain.toml");
        expect(diagnostics.toolchain_pinned).toBe(true);

        const imageToolchain = requiredString(diagnostics, "rustup_toolchain");
        expect(imageToolchain).not.toBe(SOURCE_REQUESTED_TOOLCHAIN);
        expect(imageToolchain).not.toMatch(/^1\.99\.0(?:-|$)/);

        const log = await readJobLog(run.jobId);
        expectStatus(log, 200);
        assertBuildLogRedacted(log.text);
        expect(log.text).toContain(`RUSTUP_TOOLCHAIN=${imageToolchain}`);
        expect(log.text).not.toMatch(new RegExp(`RUSTUP_TOOLCHAIN=${SOURCE_REQUESTED_TOOLCHAIN.replace(".", "\\.")}`));

        expect(log.text).not.toMatch(new RegExp(`(?:syncing|installing|downloading)[^\\n]{0,160}${SOURCE_REQUESTED_TOOLCHAIN.replace(".", "\\.")}`, "i"));
      },
      env.jobTimeoutMs + 60_000
    );
  }
);
