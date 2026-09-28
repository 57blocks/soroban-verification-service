import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingDeployedTarget, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { staticSourceUrl } from "../../support/routes.js";
import { readReportByUrl } from "../../support/result-tree.js";
import type { ContractFixture } from "../../support/fixtures.js";

const URI_PRIVATE_VERIFIED = "F-URI-PRIV";
const URI_PUBLIC_MISMATCH = "F-URI-MISMATCH";

function sourceUriFixtureProblem(id: string, requiresPublisherFetch = false): string | undefined {
  const missing = missingDeployedTarget(id);
  if (missing) return missing;

  const fixture = fixtures.contracts[id];
  if (!fixture.source_uri || !fixture.source_sha256) {
    return `fixture ${id} needs source_uri and source_sha256`;
  }

  try {
    const uri = new URL(fixture.source_uri);
    if (requiresPublisherFetch && uri.protocol !== "https:") {
      return `fixture ${id} source_uri must use https so the publisher can retain it`;
    }
  } catch {
    return `fixture ${id} source_uri is not an absolute URL`;
  }

  return undefined;
}

function sourceFileNameFromUri(fixture: ContractFixture): string {
  const sourceSha256 = fixture.source_sha256;
  const sourceUri = fixture.source_uri;
  if (!sourceSha256 || !sourceUri) {
    throw new Error(`fixture ${fixture.id} has no source URI identity`);
  }

  const path = new URL(sourceUri).pathname;
  const match = /(\.tar\.[a-z0-9]+|\.[a-z0-9]+)$/i.exec(path);
  return `${sourceSha256}${match ? match[1].toLowerCase() : ".tar.gz"}`;
}

async function assertFixtureOrigin(fixture: ContractFixture): Promise<void> {
  const origin = await http(fixture.source_uri!, { bare: true });
  expectStatus(origin, 200);
  expect(sha256Hex(origin.bytes)).toBe(fixture.source_sha256);
}

async function assertSourceKeyUnused(fixture: ContractFixture): Promise<void> {
  const existing = await http(staticSourceUrl(sourceFileNameFromUri(fixture)));
  if ([403, 404].includes(existing.status)) return;

  throw new Error(
    `Fixture ${fixture.id} source key is already public: ${existing.url} returned ${existing.status}. ` +
      "Use a fresh archive hash or remove the stale object before running this case.",
  );
}

async function assertExistingPublicSourceIsCorrect(fixture: ContractFixture): Promise<void> {
  const existing = await http(staticSourceUrl(sourceFileNameFromUri(fixture)));
  if ([403, 404].includes(existing.status)) return;
  expectStatus(existing, 200);
  expect(sha256Hex(existing.bytes)).toBe(fixture.source_sha256);
}

caseBlock(
  {
    id: "E2E-SRC-05/uri_declared_private",
    title: "a verified URI source declared private is not retained",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => sourceUriFixtureProblem(URI_PRIVATE_VERIFIED),
  },
  () => {
    it(
      "keeps the URI and commitment on the report without writing a static source copy",
      async () => {
        const fixture = fixtures.contracts[URI_PRIVATE_VERIFIED];
        await assertFixtureOrigin(fixture);
        await assertSourceKeyUnused(fixture);

        const run = await submitAndWait(
          await submissionFor(URI_PRIVATE_VERIFIED, { is_public: false }),
        );
        expect(run.body.status).toBe("verified");

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.source).toEqual(
          expect.objectContaining({
            is_public: false,
            source_sha256: fixture.source_sha256,
            source_uri: fixture.source_uri,
          }),
        );
        expect(artifact.source!.source_file_name).toBeUndefined();

        const stored = await http(staticSourceUrl(sourceFileNameFromUri(fixture)));
        expect([403, 404]).toContain(stored.status);
      },
      env.jobTimeoutMs + 120_000,
    );
  },
);

caseBlock(
  {
    id: "E2E-SRC-02/uri_declared_public_mismatch",
    title: "a mismatched URI source declared public is retained",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => sourceUriFixtureProblem(URI_PUBLIC_MISMATCH, true),
  },
  () => {
    it(
      "writes the declared public URI source even though its rebuild mismatches",
      async () => {
        const fixture = fixtures.contracts[URI_PUBLIC_MISMATCH];
        await assertFixtureOrigin(fixture);
        await assertExistingPublicSourceIsCorrect(fixture);

        const run = await submitAndWait(
          await submissionFor(URI_PUBLIC_MISMATCH, { is_public: true }),
        );
        expect(run.body.status).toBe("mismatch");

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.result.matched).toBe(false);
        expect(artifact.source).toEqual(
          expect.objectContaining({
            is_public: true,
            source_sha256: fixture.source_sha256,
            source_uri: fixture.source_uri,
          }),
        );
        expect(artifact.source!.source_file_name).toBe(sourceFileNameFromUri(fixture));

        const stored = await http(staticSourceUrl(artifact.source!.source_file_name!));
        expectStatus(stored, 200);
        expect(sha256Hex(stored.bytes)).toBe(fixture.source_sha256);
      },
      env.jobTimeoutMs + 120_000,
    );
  },
);
