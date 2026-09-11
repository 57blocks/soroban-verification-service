/** The three rules together say something precise about what a verdict *is*. */
import { caseBlock, rowTest } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, sourceOf, submissionFor } from "../../support/fixtures.js";
import {
  evaluateNoSecondBuild,
  expectNoSecondBuild,
  expectSecondBuildHappened,
  observeBuild,
} from "../../support/dedup.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { staticSourceUrl } from "../../support/routes.js";
import {
  ownEntryOf,
  ownVerifierIdentity,
  readStatusObject,
  reportForJob,
  requireStatusObject,
} from "../../support/result-tree.js";

const DOUBLE_JOB_TIMEOUT = 2 * env.jobTimeoutMs + 120_000;

async function requirePublishedStatus(wasmHash: string) {
  const status = await readStatusObject(wasmHash);
  if (!status.found) {
    throw new Error(`Expected a published status object for ${wasmHash}, got ${status.result.status}.`);
  }
  return status;
}

caseBlock(
  {
    id: "E2E-DEDUP-03",
    title: "the same recipe against a different target reuses the build and recomputes the verdict",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1", "F-LEG-3"),
  },
  () => {
    it(
      "answers `mismatched` for the second target while the first stays `verified`",
      async () => {
        const h1 = fixtures.contracts["F-LEG-1"];

        // H₂ is the dedicated cli-legacy mismatch target. It records the same (cliver, rsver) pair as H₁, so
        // changing only the target really does reuse the same effective recipe.
        const h2 = fixtures.contracts["F-LEG-3"];
        if (h2.contract_id === h1.contract_id || h2.wasm_hash === h1.wasm_hash) {
          throw new Error(
            "E2E-DEDUP-03 needs F-LEG-3 to be a second cli-legacy target with a different " +
              `wasm_hash from F-LEG-1 (${h1.wasm_hash}).`
          );
        }

        const firstRun = await submitAndWait(await submissionFor("F-LEG-1"));
        expect(firstRun.body.status).toBe("verified");
        const firstReport = await reportForJob(firstRun.body.result, firstRun.body.result?.wasm_hash);
        const first = await observeBuild(firstRun.jobId, firstRun, firstReport?.artifact);

        // Recipe R unchanged; only the target moves.
        const rAgainstH2 = await submissionFor("F-LEG-1");
        rAgainstH2.target = {
          network: h2.network,
          ...(h2.contract_id ? { contract_id: h2.contract_id } : { wasm_hash: h2.wasm_hash }),
        };

        const secondRun = await submitAndWait(rAgainstH2);
        const secondReport = await reportForJob(
          secondRun.body.result,
          secondRun.body.result?.wasm_hash
        );
        const second = await observeBuild(secondRun.jobId, secondRun, secondReport?.artifact);

        // HA1 — never `verified`. This is the assertion the case exists for.
        expect(secondRun.body.status).toBe("mismatch");

        // HA2 — and it got there without building again.
        expectNoSecondBuild(evaluateNoSecondBuild(first, second));

        const identity = await ownVerifierIdentity();

        // Step 3 — H₂'s published record carries the rebuilt hash (SO2), and it is R's output, not H₂'s
        // deployed bytes.
        const h2Hash = secondRun.body.result?.wasm_hash ?? h2.wasm_hash!;
        const h2Status = await requireStatusObject(h2Hash);
        const h2Entry = ownEntryOf(h2Status.source_code_verifications, identity);
        expect(h2Entry?.status).toBe("mismatched");
        expect(h2Entry?.rebuilt_hash).toBeDefined();
        expect(h2Entry!.rebuilt_hash).not.toBe(h2Hash);
        expect(h2Entry!.rebuilt_hash).toBe(first.artifact?.result?.rebuilt_wasm_hash);

        // Step 5 — H₁ is untouched. A verdict recomputation that overwrote the earlier result would silently
        // retract a published `verified`.
        const h1Hash = firstRun.body.result?.wasm_hash ?? h1.wasm_hash!;
        const h1Status = await requireStatusObject(h1Hash);
        expect(ownEntryOf(h1Status.source_code_verifications, identity)?.status).toBe("verified");
      },
      DOUBLE_JOB_TIMEOUT
    );
  }
);

caseBlock(
  {
    id: "E2E-DEDUP-03/cross_network",
    title: "network is not part of the key — identical bytes on the other chain reuse the build",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-XNET", "F-XNET-MAINNET"),
  },
  () => {
    it(
      "verifies on both networks from one build, because K3 excludes the network",
      async () => {
        const testnet = fixtures.contracts["F-XNET"];
        const mainnet = fixtures.contracts["F-XNET-MAINNET"];

        // Precondition 1 — same bytes really do sit on both chains. If the fixture is wrong, every assertion
        // below is about something else.
        expect(testnet.wasm_hash).toBe(mainnet.wasm_hash);

        const firstRun = await submitAndWait(await submissionFor("F-XNET"));
        expect(firstRun.body.status).toBe("verified");
        const firstReport = await reportForJob(firstRun.body.result, testnet.wasm_hash);
        const first = await observeBuild(firstRun.jobId, firstRun, firstReport?.artifact);

        const secondRun = await submitAndWait(await submissionFor("F-XNET-MAINNET"));
        const secondReport = await reportForJob(secondRun.body.result, mainnet.wasm_hash);
        const second = await observeBuild(secondRun.jobId, secondRun, secondReport?.artifact);

        expectNoSecondBuild(evaluateNoSecondBuild(first, second));

        // HA2.
        expect(secondRun.body.status).toBe("verified");

        // What remains true is the verdict itself.
        expect((firstReport?.artifact as Record<string, unknown> | undefined)?.target).toBeUndefined();
        expect((secondReport?.artifact as Record<string, unknown> | undefined)?.target).toBeUndefined();
        expect(firstReport?.artifact.result.matched).toBe(true);
        expect(secondReport?.artifact.result.matched).toBe(true);
      },
      DOUBLE_JOB_TIMEOUT
    );
  }
);

caseBlock(
  {
    id: "E2E-DEDUP-04/verified_is_terminal",
    title: "Rule B is scoped to the recipe that produced the verdict, not to the hash",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "re-submitting the same recipe adopts the existing artifact and does not move updated_at",
      async () => {
        const target = fixtures.contracts["F-LEG-1"];
        const body = await submissionFor("F-LEG-1");

        const firstRun = await submitAndWait(body);
        expect(firstRun.body.status).toBe("verified");
        const hash = firstRun.body.result?.wasm_hash ?? target.wasm_hash!;

        const beforeStatus = await requirePublishedStatus(hash);
        const before = beforeStatus.object;
        const beforeReportUrl = firstRun.body.result?.artifact_url;
        const beforeReport = await reportForJob(firstRun.body.result, hash);
        if (!beforeReport) {
          throw new Error("the baseline verified job exposed no report artifact");
        }
        expect(beforeReportUrl).toBeDefined();

        const secondRun = await submitAndWait(body);

        // HA1 — verified, no second report artifact, and neither published document changes.
        expect(secondRun.body.status).toBe("verified");
        expect(secondRun.body.result?.artifact_url).toBe(beforeReportUrl);

        const afterReport = await reportForJob(secondRun.body.result, hash);
        if (!afterReport) {
          throw new Error("the adopted verified job exposed no report artifact");
        }
        expect(afterReport.sha256).toBe(beforeReport.sha256);
        expect(afterReport.bytes).toEqual(beforeReport.bytes);

        const afterStatus = await requirePublishedStatus(hash);
        const after = afterStatus.object;
        expect(after.updated_at).toBe(before.updated_at);
        expect(sha256Hex(afterStatus.result.bytes)).toBe(sha256Hex(beforeStatus.result.bytes));
        expect(afterStatus.result.bytes).toEqual(beforeStatus.result.bytes);

        // HA3 — the answer arrives through the *job*, not the submit response.
        expect(secondRun.jobId).toBeDefined();
        expect(secondRun.jobId).not.toBe(firstRun.jobId);
      },
      DOUBLE_JOB_TIMEOUT
    );

    rowTest(
      "a genuinely different source for the same hash is its own job, not an adopted verdict",
      // This row needs a second source that is genuinely different *bytes* for the SAME target, and F-URI-PRIV
      // is exactly that: GitHub's archive of 7bd0765, same contract source as F-LEG-1 against the same
      // contract, a distinct full-archive hash because its README revision differs.
      missingFixture("F-URI-PRIV"),
      async () => {
        // HA2, and the reason the rule was rescoped: source-to-bytes is many-to-one.
        const base = await submissionFor("F-LEG-1");
        const alternative = await submissionFor("F-LEG-1", await sourceOf("F-URI-PRIV"));

        // The row's premise, asserted rather than assumed. Without this, a fixture that silently stops carrying
        // its own source degrades this negative control into a tautology.
        expect(alternative.manifest.source_sha256).not.toBe(base.manifest.source_sha256);
        expect(alternative.manifest.source_uri ?? alternative.manifest.upload_id).toBeDefined();
        expect(alternative.manifest.bldopt).toEqual(base.manifest.bldopt);
        expect(alternative.target).toEqual(base.target);

        const firstRun = await submitAndWait(base);
        const firstReport = await reportForJob(firstRun.body.result, firstRun.body.result?.wasm_hash);
        const first = await observeBuild(firstRun.jobId, firstRun, firstReport?.artifact);

        const secondRun = await submitAndWait(alternative);
        const secondReport = await reportForJob(
          secondRun.body.result,
          secondRun.body.result?.wasm_hash
        );
        const second = await observeBuild(secondRun.jobId, secondRun, secondReport?.artifact);

        // Before the reuse evidence: a job that failed early has no verdict to have adopted, and would
        // otherwise reach `expectSecondBuildHappened` looking indistinguishable from reuse.
        expect(["verified", "mismatch"]).toContain(secondRun.body.status);
        expect(secondRun.jobId).not.toBe(firstRun.jobId);

        expectSecondBuildHappened(evaluateNoSecondBuild(first, second));
      },
      DOUBLE_JOB_TIMEOUT
    );
  }
);

caseBlock(
  {
    id: "E2E-DEDUP-05",
    title: "Rule C — a mismatch is not rerun, but a different candidate is a new job",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-3"),
  },
  () => {
    it(
      "/identical_input_not_rerun — the same mismatching input returns the existing result",
      async () => {
        const firstRun = await submitAndWait(await submissionFor("F-LEG-3"));
        // HA1 — and note this is `mismatch` on the job surface, not `failed`: the run succeeded.
        expect(firstRun.body.status).toBe("mismatch");
        const hash = firstRun.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-3"].wasm_hash!;
        const beforeStatus = await requirePublishedStatus(hash);
        const firstReport = await reportForJob(firstRun.body.result, hash);
        if (!firstReport) {
          throw new Error("the baseline mismatched job exposed no report artifact");
        }
        const first = await observeBuild(firstRun.jobId, firstRun, firstReport?.artifact);
        const firstArtifactUrl = firstRun.body.result?.artifact_url;
        expect(firstArtifactUrl).toBeDefined();

        // Upload IDs are single-use service capabilities.
        const secondRun = await submitAndWait(await submissionFor("F-LEG-3"));
        const secondReport = await reportForJob(secondRun.body.result, hash);
        if (!secondReport) {
          throw new Error("the adopted mismatched job exposed no report artifact");
        }
        const second = await observeBuild(secondRun.jobId, secondRun, secondReport?.artifact);

        // Rerunning it would burn a build slot to reproduce a result nobody disputed.
        expectNoSecondBuild(evaluateNoSecondBuild(first, second));

        // HA3 — a repeated mismatch reuses the same immutable evidence and does not rewrite the status object.
        expect(secondRun.body.status).toBe("mismatch");
        expect(secondRun.body.result?.rebuilt_wasm_hash).toBe(firstRun.body.result?.rebuilt_wasm_hash);
        expect(secondRun.body.result?.artifact_url).toBe(firstArtifactUrl);
        expect(secondReport.sha256).toBe(firstReport.sha256);
        expect(secondReport.bytes).toEqual(firstReport.bytes);

        const afterStatus = await requirePublishedStatus(hash);
        expect(afterStatus.object.updated_at).toBe(beforeStatus.object.updated_at);
        expect(sha256Hex(afterStatus.result.bytes)).toBe(sha256Hex(beforeStatus.result.bytes));
        expect(afterStatus.result.bytes).toEqual(beforeStatus.result.bytes);
      },
      DOUBLE_JOB_TIMEOUT
    );

    rowTest(
      "/different_input_is_new_job — two candidates for one hash are recorded independently",
      missingFixture("F-MISMATCH-ALT"),
      async () => {
        const hashOwner = fixtures.contracts["F-LEG-3"];

        // Both public, so step 5 can retrieve them. A private candidate is not retained, and the case would
        // then be asserting the absence of something it never asked to be stored.
        const s1 = await submissionFor("F-LEG-3", { is_public: true });
        const s2 = await submissionFor("F-MISMATCH-ALT", { is_public: true });
        expect(s2.manifest.source_sha256).not.toBe(s1.manifest.source_sha256);
        expect(s2.target).toEqual(s1.target);

        const firstRun = await submitAndWait(s1);
        expect(firstRun.body.status).toBe("mismatch");
        const firstReport = await reportForJob(firstRun.body.result, firstRun.body.result?.wasm_hash);
        const first = await observeBuild(firstRun.jobId, firstRun, firstReport?.artifact);

        const secondRun = await submitAndWait(s2);
        expect(secondRun.body.status).toBe("mismatch");
        const secondReport = await reportForJob(
          secondRun.body.result,
          secondRun.body.result?.wasm_hash
        );
        const second = await observeBuild(secondRun.jobId, secondRun, secondReport?.artifact);

        // HA1 — a different `source_sha256` is a different key, so this really is a new build.
        expectSecondBuildHappened(evaluateNoSecondBuild(first, second));

        // HA2 as written in the case file asserts "**two** mismatched records from this verifier, one per
        // source".
        const hash = secondRun.body.result?.wasm_hash ?? hashOwner.wasm_hash!;
        const statusObject = await requireStatusObject(hash);
        expect(statusObject.source_code_verifications).toHaveLength(1);
        const identity = await ownVerifierIdentity();
        const ours = ownEntryOf(statusObject.source_code_verifications, identity);
        expect(ours).toBeDefined();
        expect(ours!.status).toBe("mismatched");

        // The entry describes S2, not S1 — which is what makes the second submission a real job rather than a
        // no-op that returned the first one's answer.
        expect(ours!.rebuilt_hash).toBe(second.artifact?.result?.rebuilt_wasm_hash);
        expect(ours!.rebuilt_hash).not.toBe(first.artifact?.result?.rebuilt_wasm_hash);

        // Both reports still resolve.
        expect(firstReport?.sha256).toBeDefined();
        expect(secondReport?.sha256).toBeDefined();
        expect(firstReport!.sha256).not.toBe(secondReport!.sha256);

        // HA4 — each candidate archive is still retrievable by its own `source_sha256`, including the one the
        // index no longer points at.
        for (const report of [firstReport!, secondReport!]) {
          const fileName = report.artifact.source?.source_file_name;
          expect(fileName).toBeDefined();
          const archive = await http(staticSourceUrl(fileName!));
          expectStatus(archive, 200);
          expect(sha256Hex(archive.bytes)).toBe(report.artifact.source!.source_sha256);
        }
      },
      DOUBLE_JOB_TIMEOUT,
    );
  }
);
