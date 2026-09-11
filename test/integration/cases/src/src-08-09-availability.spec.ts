/**
 * ── What SRC-08 needs that this repository cannot yet supply ────────────────────────────────────── A public
 * source URL somebody can switch **off**.
 */
import { caseBlock } from "../../support/gate.js";
import { darkSourceControl, env } from "../../support/env.js";
import { fixtures, missingDeployedTarget, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { staticSourceUrl } from "../../support/routes.js";
import { setDarkSourceAvailable, waitForSourceUri } from "../../support/source-control.js";
import {
  ownEntryOf,
  ownVerifierIdentity,
  readReportByUrl,
  requireStatusObject,
} from "../../support/result-tree.js";
import type { RegistryVerification, VerificationArtifact } from "../../support/types.js";

const SRC08 = "E2E-SRC-08";

/** A loopback origin is the mistake this case cannot detect any other way — see the header. */
function unreachableByDeployment(sourceUri: string | undefined): string | undefined {
  if (!sourceUri) return "F-DARK carries no source_uri";
  let url: URL;
  try {
    url = new URL(sourceUri);
  } catch {
    return `F-DARK's source_uri is not an absolute URL: ${JSON.stringify(sourceUri)}`;
  }
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname)) {
    return (
      `F-DARK's source_uri is ${url.hostname}, which only the harness can reach. The verifier is ` +
      `what fetches the source, so the verification would fail for a reason SRC-08 is not about. ` +
      `Bind dark-source-server.mjs with SCVS_FIXTURE_DARK_HOST=0.0.0.0 behind an address the ` +
      `deployment resolves, and record that address as F-DARK's source_uri.`
    );
  }
  return undefined;
}

function darkFixtureIsIndistinct(): string | undefined {
  const dark = fixtures.contracts["F-DARK"];
  if (!dark?.source_sha256) return "F-DARK carries no source_sha256";
  const clash = Object.values(fixtures.contracts).find(
    (other) => other.id !== dark.id && other.source_sha256 === dark.source_sha256
  );
  return clash
    ? `F-DARK shares its source_sha256 with ${clash.id}, so a retained copy found after the origin ` +
        `goes dark could be that fixture's. SRC-08 needs an archive of its own.`
    : undefined;
}

caseBlock(
  {
    id: SRC08,
    title: "the verdict and the report survive the original source disappearing",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => {
      const missing = missingDeployedTarget("F-DARK");
      if (missing) return missing;
      if (darkSourceControl.kind === "absent") return `📐 ${darkSourceControl.describe}`;
      return (
        unreachableByDeployment(fixtures.contracts["F-DARK"].source_uri) ?? darkFixtureIsIndistinct()
      );
    },
  },
  () => {
    const dark = fixtures.contracts["F-DARK"];

    // State captured while the origin is still up, and read by both rows.
    let recorded:
      | {
          wasmHash: string;
          verdict: string;
          entry: RegistryVerification;
          artifact: VerificationArtifact;
          reportSha256: string;
          reportUrl: string;
        }
      | undefined;

    beforeAll(async () => {
      // Shared precondition 1-3: serve it, verify from it, record what was published.
      await setDarkSourceAvailable(true, SRC08);
      await waitForSourceUri(dark.source_uri!, "reachable");

      const run = await submitAndWait(await submissionFor("F-DARK", { is_public: true }));

      // Pinning it would make this case fail whenever the fixture is set up as a mismatch candidate, which is a
      // fixture choice, not a conformance finding.
      expect(["verified", "mismatch"]).toContain(run.body.status);

      const wasmHash = run.body.result!.wasm_hash!;
      const reportUrl = run.body.result!.artifact_url!;
      const report = await readReportByUrl(reportUrl);
      const status = await requireStatusObject(wasmHash);
      const entry = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
      expect(entry).toBeDefined();

      // The retained copy has to exist *before* the origin goes dark, or the row below cannot tell "retention
      // worked and outlived the origin" from "retention never happened".
      expect(report.artifact.source?.is_public).toBe(true);
      expect(report.artifact.source?.source_sha256).toBe(dark.source_sha256);
      const beforeCopy = await http(staticSourceUrl(report.artifact.source!.source_file_name!));
      expectStatus(beforeCopy, 200);

      recorded = {
        wasmHash,
        verdict: entry!.status,
        entry: entry!,
        artifact: report.artifact,
        reportSha256: report.sha256,
        reportUrl,
      };

      // Shared step 1-2: switch the origin off and prove it, then let one publication cycle pass.
      await setDarkSourceAvailable(false, SRC08);
      await waitForSourceUri(dark.source_uri!, "gone");
    }, 2 * env.jobTimeoutMs + 180_000);

    afterAll(async () => {
      // Leave the fixture serving. A dark F-DARK silently breaks every later run of this case, and "the
      // previous run crashed" is not a state the next runner should have to diagnose.
      if (darkSourceControl.kind === "endpoint") {
        await setDarkSourceAvailable(true, SRC08).catch(() => undefined);
      }
    });

    it("/verdict_unchanged — the published verdict is exactly what it was", async () => {
      expect(recorded).toBeDefined();
      const status = await requireStatusObject(recorded!.wasmHash);
      const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());

      // HA — not downgraded, not withdrawn, not rewritten to `unverified`.
      expect(ours).toBeDefined();
      expect(ours!.status).toBe(recorded!.verdict);
      expect(ours!.status).not.toBe("unverified");
      expect(ours!.rebuilt_hash).toBe(recorded!.entry.rebuilt_hash);
      expect(ours!.processed_at).toBe(recorded!.entry.processed_at);
    });

    it("/visibility_reflects_reality — our copy still serves, and the report has not moved", async () => {
      expect(recorded).toBeDefined();

      // The origin really is gone. Asserted here as well as waited for above, because everything else in this
      // row is only interesting while that is true.
      const origin = await http(dark.source_uri!, { bare: true });
      expect([404, 410]).toContain(origin.status);

      const fileName = recorded!.artifact.source!.source_file_name!;
      const copy = await http(staticSourceUrl(fileName));
      expectStatus(copy, 200);
      expect(sha256Hex(copy.bytes)).toBe(dark.source_sha256);

      // RA2, in the form this deployment can be held to: the report is immutable, so refetching it returns the
      // same bytes and therefore the same verification-time facts.
      const again = await readReportByUrl(recorded!.reportUrl);
      expect(again.sha256).toBe(recorded!.reportSha256);
      expect(again.artifact.source?.is_public).toBe(true);
      expect(again.artifact.source?.source_sha256).toBe(dark.source_sha256);

      // ── The row's literal claim, on the field that carries it (TRD §5.2) ───────────────────
      // `source_uri` is a **verification-time** fact. Re-read rather than reused from `recorded`, because "the
      // value we captured" and "the value served now" are the two things being compared.
      const currentStatus = await requireStatusObject(recorded!.wasmHash);
      const currentEntry = ownEntryOf(currentStatus.source_code_verifications, await ownVerifierIdentity());
      expect(currentEntry!.source_uri).toBe(dark.source_uri);
      expect(currentEntry!.source_sha256).toBe(dark.source_sha256);
    });
  }
);
