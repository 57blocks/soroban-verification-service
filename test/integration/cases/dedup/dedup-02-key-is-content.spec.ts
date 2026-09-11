/** E2E-DEDUP-02 — the idempotency key is over content, not location or spelling */
import { caseBlock, rowTest } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixture, fixtures, missingFixture, sourceOf, submissionFor } from "../../support/fixtures.js";
import {
  evaluateNoSecondBuild,
  expectNoSecondBuild,
  expectSecondBuildHappened,
  observeBuild,
} from "../../support/dedup.js";
import { submitAndWait } from "../../support/job.js";
import { reportForJob } from "../../support/result-tree.js";
import type { SubmitBody } from "../../support/types.js";

const DOUBLE_JOB_TIMEOUT = 2 * env.jobTimeoutMs + 120_000;

async function runPair(first: SubmitBody, second: SubmitBody) {
  const firstRun = await submitAndWait(first);
  const firstReport = await reportForJob(firstRun.body.result, firstRun.body.result?.wasm_hash);
  const a = await observeBuild(firstRun.jobId, firstRun, firstReport?.artifact);

  const secondRun = await submitAndWait(second);
  const secondReport = await reportForJob(secondRun.body.result, secondRun.body.result?.wasm_hash);
  const b = await observeBuild(secondRun.jobId, secondRun, secondReport?.artifact);

  return { a, b, firstReport, secondReport, verdict: evaluateNoSecondBuild(a, b) };
}

caseBlock(
  {
    id: "E2E-DEDUP-02",
    title: "content decides the key; location and spelling do not",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    rowTest(
      "/same_bytes_different_url — K1: the same bytes at another URL reuse the build",
      fixtures.mirrored_source ? undefined : "fixtures.mirrored_source is not in the inventory",
      async () => {
        const mirror = fixtures.mirrored_source!;

        const { verdict, firstReport, secondReport } = await runPair(
          await submissionFor("F-LEG-1", { source_uri: mirror.url_a, source_sha256: mirror.sha256 }),
          await submissionFor("F-LEG-1", { source_uri: mirror.url_b, source_sha256: mirror.sha256 })
        );

        expectNoSecondBuild(verdict);

        // So the shared report names URL-A, the location the one build actually read.
        expect(firstReport?.artifact.source?.source_uri).toBe(mirror.url_a);
        expect(secondReport?.artifact.source?.source_uri).toBe(mirror.url_a);
        expect(secondReport?.sha256).toBe(firstReport?.sha256);
      },
      DOUBLE_JOB_TIMEOUT
    );

    rowTest(
      "/reordered_bldopt — K2: a permutation of the same flags reuses the build",
      (fixtures.contracts["F-LEG-1"]?.bldopt?.length ?? 0) >= 3
        ? undefined
        : "F-LEG-1 carries fewer than three bldopt entries, so reversing them is a swap rather than a permutation; add entries to the fixture",
      async () => {
        // F-LEG-1's OWN options, reversed — not the illustrative `--package=foo` triple that E2E-DEDUP.md's
        // table spells out.
        const ordered = fixture("F-LEG-1").bldopt!;
        const reordered = [...ordered].reverse();

        const { verdict } = await runPair(
          await submissionFor("F-LEG-1", { bldopt: ordered }),
          await submissionFor("F-LEG-1", { bldopt: reordered })
        );

        // A new build here would mean `bldopt` entered the hash without being sorted first — exactly what K2
        // forbids, and a submitter reordering flags harmlessly would pay for a full rebuild.
        expectNoSecondBuild(verdict);
      },
      DOUBLE_JOB_TIMEOUT
    );

    rowTest(
      "/absent_vs_explicit_bldarg — K4: omitting bldarg equals the documented default",
      undefined,
      async () => {
        const withoutBldarg = await submissionFor("F-LEG-1");
        delete (withoutBldarg.manifest as { bldarg?: string[] }).bldarg;

        const { verdict } = await runPair(
          withoutBldarg,
          await submissionFor("F-LEG-1", { bldarg: ["contract", "build"] })
        );

        expectNoSecondBuild(verdict);
      },
      DOUBLE_JOB_TIMEOUT
    );

    rowTest(
      "/same_url_changed_content — K1, inverted: different bytes are a different key",
      // F-LEG-3's own guard, not `mirrored_source`'s: this row does not use the mirror at all.
      missingFixture("F-LEG-3"),
      async () => {
        // The negative control for this whole case.
        const base = await submissionFor("F-LEG-1");
        const changed = await submissionFor("F-LEG-1", await sourceOf("F-LEG-3"));

        // The row's premise, asserted rather than assumed.
        expect(changed.manifest.source_sha256).not.toBe(base.manifest.source_sha256);
        expect(changed.manifest.source_uri ?? changed.manifest.upload_id).toBeDefined();
        expect(changed.manifest.bldopt).toEqual(base.manifest.bldopt);
        expect(changed.target).toEqual(base.target);

        const { verdict, b } = await runPair(base, changed);

        // A job that failed before building has no rebuilt artifact and is indistinguishable from a fast reuse
        // hit.
        expect(["verified", "mismatch"]).toContain(b.terminal.body.status);
        expect(b.artifactIsOwn).toBe(true);

        expectSecondBuildHappened(verdict);
      },
      DOUBLE_JOB_TIMEOUT
    );
  }
);
