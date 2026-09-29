import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLegacyCustody, readReport } from "./read.js";
import { createResultStorage } from "./storage-backend.js";
import { reportKey } from "./keys.js";

function preExistingShapedReport(overrides: { build_recipe?: unknown } = {}): Record<string, unknown> {
  return {
    schema: "stellar-verification-artifact-v1",
    verifier: { id: "dev-verifier", policy_id: "default" },
    provenance: { recipe_source: "on_chain_metadata", build_isolation: "network_isolated" },
    trust: { sep55_attestation_present: false },
    source: { source_sha256: "a".repeat(64), is_public: true },
    result: {
      status_summary: "verified",
      wasm_hash: "b".repeat(64),
      rebuilt_wasm_hash: "b".repeat(64),
      matched: true,
      verified_at: "2026-08-07T00:00:00.000Z",
    },
    build_recipe: {
      build_image: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
      build_environment: {
        kind: "chain_named",
        trust_level: "official_trusted",
        image_reference: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
      },
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "scvs-legacy-report-"));
  await mkdir(join(root, "reports"), { recursive: true });
  const storage = createResultStorage({ kind: "filesystem", root, publicRoot: "http://localhost/public" });

  const reportSha256 = "d".repeat(64);
  await writeFile(join(root, reportKey(reportSha256)), JSON.stringify(preExistingShapedReport()), "utf8");

  const report = await readReport(storage, reportSha256);
  assert.ok(report, "a report published before image_trust_level/build_recipe were schema-enforced must still parse");
  assert.equal(report.image_trust_level, undefined);

  const custody = await readLegacyCustody(storage, reportSha256);
  assert.deepEqual(custody, { imageTrustLevel: "official_trusted" });

  const composedSha256 = "e".repeat(64);
  await writeFile(
    join(root, reportKey(composedSha256)),
    JSON.stringify(
      preExistingShapedReport({
        build_recipe: {
          build_image: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:${"f".repeat(64)}`,
          build_environment: {
            kind: "composed",
            trust_level: "upstream_pinned",
            recipe_sha256: "1".repeat(64),
            image_digest: `sha256:${"f".repeat(64)}`,
            image_reference: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:${"f".repeat(64)}`,
            recipe: {
              schema: "scvs-composed-environment-v1",
              pair: { cliver: "25.1.0", rsver: "1.95.0" },
              template_version: "v1",
              components: [
                { kind: "base_image", source: "docker.io/library/debian", sha256: `sha256:${"2".repeat(64)}` },
              ],
            },
          },
        },
      }),
    ),
    "utf8",
  );

  const composedCustody = await readLegacyCustody(storage, composedSha256);
  assert.deepEqual(composedCustody, { imageTrustLevel: "upstream_pinned" });

  console.log(
    "readReport/readLegacyCustody: a report published before image_trust_level existed still parses, and its " +
      "trust level is still recoverable through the legacy build_recipe.build_environment.trust_level fallback " +
      "(chain_named and composed) passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
