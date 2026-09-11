/**
 * E2E-SEC-03 — a malicious archive is refused before extraction E2E-SEC-04 — a `source_sha256` mismatch stops
 * the build before it starts
 */
import { caseBlock, rowTest } from "../../support/gate.js";
import { archiveLimitProvenance, deploymentParameters, env } from "../../support/env.js";
import {
  benignArchive,
  entryCountBombArchive,
  pathTraversalArchive,
  sizeBombArchive,
  symlinkEscapeArchive,
  type AdversarialArchive,
} from "../../support/archives.js";
import { fixtures, missingDeployedTarget, missingFixture, submissionFor } from "../../support/fixtures.js";
import { sha256Hex } from "../../support/http.js";
import { preflight, readJobLog, submit, submitAndWait, uploadSource, waitForTerminal } from "../../support/job.js";
import { readStatusObject } from "../../support/result-tree.js";

/** Anything only a compiler emits. Its absence is what "the build never started" looks like. */
const COMPILER_OUTPUT = /\b(cargo|rustc|Compiling|Finished\s+(dev|release)|warning: unused)\b/i;

async function submitArchive(archive: AdversarialArchive) {
  const bytes = Buffer.from(archive.bytes);
  const upload = await uploadSource(bytes, `${archive.id.replace(/\W+/g, "-")}.tar.gz`);

  // Without this the case would pass while archive validation was entirely absent.
  expect(upload.source_sha256).toBe(sha256Hex(bytes));

  const body = await submissionFor("F-LEG-1", {
    upload_id: upload.upload_id,
    source_sha256: upload.source_sha256,
  });
  delete (body.manifest as { source_uri?: string }).source_uri;

  return { body, upload };
}

caseBlock(
  {
    id: "E2E-SEC-03",
    title: "malicious archives are rejected before extraction",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    const { limitTarEntries, limitUncompressedBytes, limitArchiveBytes } = deploymentParameters;

    /** The bound this row is *about* is the only one it may exceed. */
    const singleCause = (archive: AdversarialArchive, undertest: "entries" | "uncompressed" | "none") => {
      if (limitArchiveBytes !== undefined) {
        // `source_archive_too_large` bounds the *compressed* download and is checked before the archive is ever
        // listed, so an oversized upload never reaches the control under test.
        expect(archive.compressedBytes).toBeLessThan(limitArchiveBytes);
      }
      if (undertest !== "entries" && limitTarEntries !== undefined) {
        expect(archive.materialisedEntries).toBeLessThanOrEqual(limitTarEntries);
      }
      if (undertest !== "uncompressed" && limitUncompressedBytes !== undefined) {
        expect(archive.declaredUncompressedBytes).toBeLessThanOrEqual(limitUncompressedBytes);
      }

      // The path and link rows need no deployment bound to build, so they must not *depend* on one for
      // attribution either.
      if (undertest === "none") {
        expect(archive.materialisedEntries).toBeLessThan(16);
        expect(archive.declaredUncompressedBytes).toBeLessThan(64 * 1024);
      }
    };

    const rows: {
      suffix: string;
      build: () => Promise<AdversarialArchive>;
      /** Which bound the archive deliberately exceeds; every other one must be respected. */
      undertest: "entries" | "uncompressed" | "none";
      unavailable?: string;
    }[] = [
      { suffix: "path_traversal", build: pathTraversalArchive, undertest: "none" },
      { suffix: "symlink_escape", build: symlinkEscapeArchive, undertest: "none" },
      {
        suffix: "entry_count_bomb",
        build: () => entryCountBombArchive(limitTarEntries!),
        undertest: "entries",
        unavailable: limitTarEntries
          ? undefined
          : `📐 ${archiveLimitProvenance.limitTarEntries} — the case says not to invent a value`,
      },
      {
        suffix: "size_bomb",
        build: () => sizeBombArchive(limitUncompressedBytes!),
        undertest: "uncompressed",
        unavailable: limitUncompressedBytes
          ? undefined
          : `📐 ${archiveLimitProvenance.limitUncompressedBytes} — the case says not to invent a value`,
      },
    ];

    for (const row of rows) {
      rowTest(
        `/${row.suffix}`,
        row.unavailable,
        async () => {
          const archive = await row.build();

          // Printed, not just asserted: a boundary case whose threshold and provenance are invisible in the
          // report is one nobody can re-check against the deployment afterwards.
          console.log(
            `[E2E-SEC-03/${row.suffix}] ${archive.attack}; entries=${archive.materialisedEntries} ` +
              `declared=${archive.declaredUncompressedBytes} compressed=${archive.compressedBytes}; ` +
              `bounds: ${archiveLimitProvenance.limitTarEntries} | ` +
              `${archiveLimitProvenance.limitUncompressedBytes} | ${archiveLimitProvenance.limitArchiveBytes}; ` +
              // Printed, never asserted: the code lives in the component tests that own it.
              `component-test code: ${archive.expectedReason || "(none — conformant control)"}`
          );
          singleCause(archive, row.undertest);
          if (row.undertest === "entries") {
            expect(archive.materialisedEntries).toBe(limitTarEntries! + 1);
          }
          if (row.undertest === "uncompressed") {
            expect(archive.declaredUncompressedBytes).toBe(limitUncompressedBytes! + 1);
          }

          const { body } = await submitArchive(archive);
          const outcome = await submit(body);

          // A synchronous refusal is still a pass.
          if (!outcome.jobId) {
            expect(outcome.response.status).toBeGreaterThanOrEqual(400);
            expect(["source_unreachable", "policy_rejected", "unsupported"]).toContain(
              outcome.response.json?.error
            );
            return;
          }

          const run = await submitAndWait(body);

          // HA 1 — fail closed. The archive is hash-correct, so nothing upstream of extraction can have stopped
          // it.
          expect(["verified", "mismatch"]).not.toContain(run.body.status);

          // It is also the assertion that catches a deployment whose real bound is *higher* than the artefact
          // declared: that archive is not refused at all, and lands here as `build_failed` instead.
          expect(run.body.status).toBe("source_unavailable");

          // HA 3 — "fails before extraction and before any `cargo` or `rustc` output".
          const log = await readJobLog(run.jobId);
          expect([200, 404]).toContain(log.status);
          if (log.status === 404) {
            expect(log.json?.error).toBe("not_found");
            expect(log.json?.failure_reason).toBe("source_unreachable");
          } else {
            expect(log.text).not.toMatch(COMPILER_OUTPUT);
            // The builder's only way to start a build is `docker`; the materialiser holds no socket.
            expect(log.text).not.toMatch(/\bdocker\s+(run|build|create)\b/i);
          }

          // HA 4 — nothing published. The bytes are named by their own hash, so a stale object from another run
          // cannot mask this: what must be absent is *this* archive's hash, not the status object.
          if (fixtures.contracts["F-LEG-1"].wasm_hash) {
            const published = await readStatusObject(fixtures.contracts["F-LEG-1"].wasm_hash!);
            if (published.found) {
              const rebuilt = published.object.source_code_verifications.map((e) => e.tarball_sha256);
              expect(rebuilt).not.toContain(sha256Hex(Buffer.from(archive.bytes)));
            }
          }
        },
        env.jobTimeoutMs + 60_000
      );
    }
  }
);

caseBlock(
  {
    id: "E2E-SEC-04/cli_58_chain_hash_mismatch",
    title: "a cli-58 upload cannot replace the chain source hash",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget("F-58"),
  },
  () => {
    it("rejects an upload whose hash differs from the chain-recorded source_sha256", async () => {
      const target = fixtures.contracts["F-58"];
      const inspected = await preflight({
        network: target.network,
        contract_id: target.contract_id,
        wasm_hash: target.wasm_hash,
      });
      expect(inspected.status).toBe(200);

      // This is the deployed cli-58 recipe, not a fixture-side approximation of it.
      const chainManifest = inspected.json?.suggested_manifest;
      expect(chainManifest).toEqual(
        expect.objectContaining({
          bldimg: expect.any(String),
          source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          source_uri: expect.any(String),
        }),
      );
      const chainSourceSha256 = chainManifest.source_sha256 as string;

      const archive = benignArchive("sec-04-cli58-chain-hash-mismatch");
      const upload = await uploadSource(Buffer.from(archive.bytes), "sec-04-cli58-chain-hash-mismatch.tar.gz");
      expect(upload.source_sha256).toBe(sha256Hex(archive.bytes));
      expect(upload.source_sha256).not.toBe(chainSourceSha256);

      // This deliberately matches the upload record, as the console does.
      const outcome = await submit({
        target: {
          network: target.network,
          contract_id: target.contract_id,
          wasm_hash: target.wasm_hash,
        },
        manifest: {
          schema: "stellar-submitted-source-verification-manifest-v1",
          bldimg: chainManifest.bldimg as string,
          ...(Array.isArray(chainManifest.bldarg) ? { bldarg: chainManifest.bldarg as string[] } : {}),
          ...(Array.isArray(chainManifest.bldopt) ? { bldopt: chainManifest.bldopt as string[] } : {}),
          source_sha256: upload.source_sha256,
          upload_id: upload.upload_id,
          is_public: false,
        },
      });

      expect(outcome.response.status).toBeGreaterThanOrEqual(400);
      expect(outcome.response.status).toBeLessThan(500);
      expect(outcome.response.json?.error).toBe("source_archive_not_chain_recorded");
      // Both hashes are named, which is what makes the refusal actionable rather than a bare "no".
      expect(outcome.response.json?.detail).toContain(upload.source_sha256);
      expect(outcome.response.json?.detail).toContain(chainSourceSha256);
      expect(outcome.jobId).toBeUndefined();
      expect(outcome.response.json?.job_id).toBeUndefined();
    }, 2 * env.requestTimeoutMs + 30_000);
  },
);

caseBlock(
  {
    id: "E2E-SEC-04",
    title: "declared hash ≠ actual bytes: the build never starts",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("refuses at the submission boundary when the manifest's hash does not match the upload", async () => {
      const archive = benignArchive("sec-04");
      const upload = await uploadSource(Buffer.from(archive.bytes), "sec-04.tar.gz");

      const body = await submissionFor("F-LEG-1", {
        upload_id: upload.upload_id,
        // A valid-looking but wrong 64-hex value — the shape passes validation, the comparison does not.
        source_sha256: "b".repeat(64),
      });
      delete (body.manifest as { source_uri?: string }).source_uri;

      const outcome = await submit(body);

      // HA2/HA3 — no job, so by construction no build and no verdict.
      expect(outcome.response.status).toBeGreaterThanOrEqual(400);
      expect(outcome.jobId).toBeUndefined();

      // At the submission boundary the deployment answers `source_hash_mismatch`, which names the actual
      // problem more precisely than "unreachable".
      expect(["source_unreachable", "source_hash_mismatch"]).toContain(outcome.response.json?.error);

      // The diagnostic the case asks for: the message should identify what was expected and what arrived, or
      // the submitter cannot tell a typo from a corrupted upload.
      const text = `${outcome.response.json?.message ?? ""} ${outcome.response.json?.detail ?? ""}`;
      expect(text.length).toBeGreaterThan(0);
    });
  }
);

caseBlock(
  {
    id: "E2E-SEC-05/manifest_path_escape",
    title: "a `--manifest-path` pointing outside the tree is refused before a verdict",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("creates no job for an escaping path", async () => {
      // Not "eventually `policy_rejected`" — a job existing at all means Batch was already dispatched for a
      // recipe that was never admissible.
      const body = await submissionFor("F-LEG-1", {
        bldopt: ["--manifest-path=../../outside/Cargo.toml"],
      });
      const outcome = await submit(body);

      expect(outcome.jobId).toBeUndefined();
      expect(outcome.response.status).toBeGreaterThanOrEqual(400);
      expect(outcome.response.json?.error).toBe("policy_rejected");
    });
  }
);
