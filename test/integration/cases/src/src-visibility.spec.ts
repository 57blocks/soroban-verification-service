import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { benignArchive } from "../../support/archives.js";
import {
  fixtures,
  missingDeployedTarget,
  missingFixture,
  privateUploadChainRecipeSubmissionFor,
  publicSourceTreeZipFixture,
  publicSourceTreeZipFixtureProblem,
  sourceTreeZipFixture,
  sourceTreeZipFixtureProblem,
  submissionFor,
} from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { preflight, submitAndWait, uploadSource } from "../../support/job.js";
import { staticSourceUrl } from "../../support/routes.js";
import {
  ownEntryOf,
  isOwnEntry,
  ownVerifierIdentity,
  readReportByUrl,
  requireStatusObject,
} from "../../support/result-tree.js";
import { sourceCodeUriUrls } from "../../support/types.js";
import type { VerificationArtifact } from "../../support/types.js";

function publishedBldopt(artifact: VerificationArtifact): string[] | undefined {
  const buildOptions = artifact.build_recipe?.build_options;
  if (!buildOptions || typeof buildOptions !== "object" || Array.isArray(buildOptions)) {
    return undefined;
  }
  const bldopt = (buildOptions as { bldopt?: unknown }).bldopt;
  return Array.isArray(bldopt) && bldopt.every((entry) => typeof entry === "string")
    ? bldopt
    : undefined;
}

/** Must match publish-time `deriveExtension()`. */
function declaredSourceFileName(sourceSha256: string, uploadedFileName: string): string {
  const match = /(\.tar\.[a-z0-9]+|\.[a-z0-9]+)$/i.exec(uploadedFileName);
  return `${sourceSha256}${match ? match[1].toLowerCase() : ".tar.gz"}`;
}

caseBlock(
  {
    id: "E2E-SRC-01",
    title: "public source is retained and served, addressed by its own hash",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "stores a copy under `sources/` keyed by source_sha256, not by wasm_hash",
      async () => {
        const target = fixtures.contracts["F-LEG-1"];
        const body = await submissionFor("F-LEG-1", { is_public: true });
        let run = await submitAndWait(body);
        expect(run.body.status).toBe("verified");

        let { artifact } = await readReportByUrl(run.body.result!.artifact_url!);

        const submittedBldopt = body.manifest.bldopt ?? [];
        const returnedBldopt = publishedBldopt(artifact);
        if (
          artifact.source?.is_public !== true &&
          returnedBldopt !== undefined &&
          JSON.stringify(returnedBldopt) !== JSON.stringify(submittedBldopt)
        ) {
          run = await submitAndWait(body);
          expect(run.body.status).toBe("verified");
          ({ artifact } = await readReportByUrl(run.body.result!.artifact_url!));
        }

        expect(artifact.source).toBeDefined();
        expect(artifact.source!.is_public).toBe(true);
        expect(artifact.source!.source_sha256).toBe(target.source_sha256);
        expect(artifact.source!.source_file_name).toBeDefined();

        const fetched = await http(staticSourceUrl(artifact.source!.source_file_name!));
        expectStatus(fetched, 200);
        expect(sha256Hex(fetched.bytes)).toBe(target.source_sha256);

        const byWasmHash = await http(staticSourceUrl(`${target.wasm_hash}.tar.gz`));
        expect([403, 404]).toContain(byWasmHash.status);
      },
      2 * env.jobTimeoutMs + 60_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SRC-05/cli_58_source_tree_zip_upload",
    title: "a ZIP source tree restores the cli-58 chain source identity",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget("F-58-ZIP") ?? sourceTreeZipFixtureProblem(),
  },
  () => {
    it(
      "verifies the uploaded ZIP whose hash is the chain source identity",
      async () => {
        const target = fixtures.contracts["F-58-ZIP"];
        const inspected = await preflight({
          network: target.network,
          contract_id: target.contract_id,
          wasm_hash: target.wasm_hash,
        });
        expectStatus(inspected, 200);

        const chainManifest = inspected.json?.suggested_manifest;
        expect(chainManifest).toEqual(
          expect.objectContaining({
            bldimg: expect.any(String),
            source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            source_uri: expect.any(String),
          }),
        );
        const chainSourceSha256 = chainManifest.source_sha256 as string;

        const zip = sourceTreeZipFixture();
        expect(zip.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        const uploaded = await uploadSource(zip.bytes, zip.filename);
        expect(uploaded.source_sha256).toBe(sha256Hex(zip.bytes));
        expect(uploaded.source_sha256).toBe(chainSourceSha256);

        const run = await submitAndWait({
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
            source_sha256: uploaded.source_sha256,
            upload_id: uploaded.upload_id,
            is_public: false,
          },
        });

        expect(run.body.status).toBe("verified");
        expect(run.body.result?.matched).toBe(true);
        expect(run.body.result?.verification_path).toBe("metadata_backed");
        expect(run.body.result?.source_reconstruction).toBeUndefined();

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.provenance.recipe_source).toBe("on_chain_metadata");
        expect(artifact.provenance.build_isolation).toBe("network_isolated");
        expect(artifact.source?.is_public).toBe(false);
        expect(artifact.source?.source_sha256).toBe(chainSourceSha256);
        expect(artifact.source?.chain_source_sha256).toBe(chainSourceSha256);
        expect(artifact.source?.source_sha256).toBe(uploaded.source_sha256);
        expect(artifact.source?.source_file_name).toBeUndefined();
        expect(artifact.result.source_reconstruction).toBeUndefined();
      },
      env.jobTimeoutMs + 120_000,
    );
  },
);

caseBlock(
  {
    id: "E2E-SRC-02/cli_58_source_tree_zip_public_upload",
    title: "a public ZIP source tree publishes the cli-58 archive recorded on chain",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget("F-58-ZIP-PUBLIC") ?? publicSourceTreeZipFixtureProblem(),
  },
  () => {
    it(
      "publishes the uploaded ZIP bytes and links them from the status object",
      async () => {
        const target = fixtures.contracts["F-58-ZIP-PUBLIC"];
        const inspected = await preflight({
          network: target.network,
          contract_id: target.contract_id,
          wasm_hash: target.wasm_hash,
        });
        expectStatus(inspected, 200);

        const chainManifest = inspected.json?.suggested_manifest;
        expect(chainManifest).toEqual(
          expect.objectContaining({
            bldimg: expect.any(String),
            source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            source_uri: expect.any(String),
          }),
        );
        const chainSourceSha256 = chainManifest.source_sha256 as string;

        const zip = publicSourceTreeZipFixture();
        const uploaded = await uploadSource(zip.bytes, zip.filename);
        expect(uploaded.source_sha256).toBe(sha256Hex(zip.bytes));
        expect(uploaded.source_sha256).toBe(chainSourceSha256);

        const run = await submitAndWait({
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
            source_sha256: uploaded.source_sha256,
            upload_id: uploaded.upload_id,
            is_public: true,
          },
        });

        expect(run.body.status).toBe("verified");
        expect(run.body.result?.matched).toBe(true);
        expect(run.body.result?.verification_path).toBe("metadata_backed");
        expect(run.body.result?.source_reconstruction).toBeUndefined();

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.provenance.recipe_source).toBe("on_chain_metadata");
        expect(artifact.provenance.build_isolation).toBe("network_isolated");
        expect(artifact.source?.is_public).toBe(true);
        expect(artifact.source?.source_sha256).toBe(chainSourceSha256);
        expect(artifact.source?.chain_source_sha256).toBe(chainSourceSha256);
        expect(artifact.source?.source_sha256).toBe(uploaded.source_sha256);
        expect(artifact.source?.source_file_name).toBeDefined();
        expect(artifact.result.source_reconstruction).toBeUndefined();

        const sourceUrl = staticSourceUrl(artifact.source!.source_file_name!);
        const source = await http(sourceUrl);
        expectStatus(source, 200);
        expect(sha256Hex(source.bytes)).toBe(chainSourceSha256);

        const wasmHash = run.body.result?.wasm_hash ?? target.wasm_hash!;
        const status = await requireStatusObject(wasmHash);
        const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
        expect(ours?.status).toBe("verified");
        expect(ours ? sourceCodeUriUrls(ours) : []).toContain(sourceUrl);
      },
      env.jobTimeoutMs + 120_000,
    );
  },
);

caseBlock(
  {
    id: "E2E-SRC-02",
    title: "an uploaded archive explicitly declared public is retained and served",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-3"),
  },
  () => {
    it(
      "retains the uploaded bytes when the submitted manifest explicitly declares them public",
      async () => {
        const body = await submissionFor("F-LEG-3", { is_public: true });
        expect("upload_id" in body.manifest).toBe(true);
        expect("source_uri" in body.manifest).toBe(false);
        expect(body.manifest.is_public).toBe(true);
        expect(body.manifest.source_sha256).toMatch(/^[0-9a-f]{64}$/);

        const run = await submitAndWait(body);
        expect(["verified", "mismatch"]).toContain(run.body.status);
        expect(run.body.result?.artifact_url).toBeDefined();

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.source).toBeDefined();
        expect(artifact.source!.is_public).toBe(true);
        expect(artifact.source!.source_sha256).toBe(body.manifest.source_sha256);
        expect(artifact.source!.source_file_name).toBeDefined();

        const fetched = await http(staticSourceUrl(artifact.source!.source_file_name!));
        expectStatus(fetched, 200);
        expect(sha256Hex(fetched.bytes)).toBe(body.manifest.source_sha256);
      },
      env.jobTimeoutMs + 120_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SRC-04",
    title: "the public declaration defaults to non-public",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("uploads with no declaration at all and is not published", async () => {
      const archive = benignArchive("src-04-default-private");
      const upload = await uploadSource(Buffer.from(archive.bytes), "src-04.tar.gz");

      expect(upload.source_sha256).toBe(sha256Hex(archive.bytes));
      expect(typeof upload.upload_id).toBe("string");
      expect(Date.parse(upload.expires_at)).toBeGreaterThan(Date.now());

      const body = await submissionFor("F-LEG-1", {
        upload_id: upload.upload_id,
        source_sha256: upload.source_sha256,
      });
      delete (body.manifest as { is_public?: boolean }).is_public;
      delete (body.manifest as { source_uri?: string }).source_uri;

      const run = await submitAndWait(body);

      const privateKey = declaredSourceFileName(upload.source_sha256, "src-04.tar.gz");
      const fetched = await http(staticSourceUrl(privateKey));
      expect([403, 404]).toContain(fetched.status);

      if (run.body.result?.artifact_url) {
        const { artifact } = await readReportByUrl(run.body.result.artifact_url);
        expect(artifact.source?.is_public ?? false).toBe(false);
      }
    }, env.jobTimeoutMs + 60_000);

    it("treats an explicitly empty declaration the same as an absent one", async () => {
      const archive = benignArchive("src-04-empty-declaration");
      const upload = await uploadSource(Buffer.from(archive.bytes), "src-04-empty.tar.gz");

      const body = await submissionFor("F-LEG-1", {
        upload_id: upload.upload_id,
        source_sha256: upload.source_sha256,
      });
      delete (body.manifest as { source_uri?: string }).source_uri;
      (body.manifest as unknown as Record<string, unknown>).is_public = null;

      const outcome = await http(`${env.verifyUrl}/api/verification/v1/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (outcome.status >= 400) {
        expect(outcome.json.error).toBe("invalid_manifest");
        return;
      }
      expectStatus(outcome, 202);
    });
  }
);

caseBlock(
  {
    id: "E2E-SRC-05",
    title: "a private source produces a normal, first-class verdict",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-PRIV"),
  },
  () => {
    it(
      "publishes the same way a public-source result does, minus the source copy",
      async () => {
        const target = fixtures.contracts["F-PRIV"];
        expect(target.source_sha256).toMatch(/^[0-9a-f]{64}$/);
        const privateSourceHash = target.source_sha256!;
        const run = await submitAndWait(await submissionFor("F-PRIV", { is_public: false }));

        expect(run.body.status).toBe("verified");

        const hash = run.body.result!.wasm_hash!;
        const status = await requireStatusObject(hash);
        const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
        expect(ours?.status).toBe("verified");

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.result.wasm_hash).toBe(hash);
        expect(artifact.source).toBeDefined();
        expect(artifact.source!.is_public).toBe(false);
        expect(artifact.source!.source_sha256).toBe(privateSourceHash);
        expect(artifact.source!.source_file_name).toBeUndefined();

        expect(ours?.verified_source_code_uris).toBeUndefined();

        const uploadFileName = target.source_path?.split("/").pop();
        expect(uploadFileName).toBeDefined();
        const privateKey = declaredSourceFileName(privateSourceHash, uploadFileName!);
        const fetched = await http(staticSourceUrl(privateKey));
        expect([403, 404]).toContain(fetched.status);
      },
      env.jobTimeoutMs + 120_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SRC-05/cli_58_private_upload",
    title: "a cli-58 private upload reaches a normal verdict",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget("F-58-PRIV"),
  },
  () => {
    it(
      "uses upload_id instead of the chain's source_uri and keeps the chain recipe authoritative",
      async () => {
        const prepared = await privateUploadChainRecipeSubmissionFor("F-58-PRIV");
        const body = prepared.body;
        expect("upload_id" in body.manifest).toBe(true);
        expect("source_uri" in body.manifest).toBe(false);
        expect(body.manifest.bldarg).toEqual(prepared.chainRecipe.bldarg);
        expect(body.manifest.bldopt).toEqual(prepared.chainRecipe.bldopt);

        const run = await submitAndWait(body);
        expect(run.body.status).toBe("verified");
        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.provenance.recipe_source).toBe("on_chain_metadata");
        expect(artifact.provenance.build_isolation).toBe("network_isolated");
        expect(artifact.source?.is_public).toBe(false);
        expect(artifact.source?.source_sha256).toBe(body.manifest.source_sha256);
        expect(artifact.source?.source_file_name).toBeUndefined();

        const status = await requireStatusObject(run.body.result!.wasm_hash!);
        const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
        expect(ours?.recipe_source).toBe("on_chain_metadata");
      },
      env.jobTimeoutMs + 120_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SRC-07",
    title: "two candidates for one hash are each retrievable by their own source hash",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-3", "F-MISMATCH-ALT"),
  },
  () => {
    it(
      "returns different content for each, and nothing for the wasm hash",
      async () => {
        const first = await submitAndWait(await submissionFor("F-LEG-3", { is_public: true }));
        const second = await submitAndWait(await submissionFor("F-MISMATCH-ALT", { is_public: true }));

        const reports = [];
        for (const run of [first, second]) {
          expect(run.body.status).toBe("mismatch");
          expect(run.body.result?.artifact_url).toBeDefined();
          reports.push(await readReportByUrl(run.body.result!.artifact_url!));
        }

        const fileNames = reports.map((report) => report.artifact.source?.source_file_name);
        expect(fileNames.every(Boolean)).toBe(true);
        expect(new Set(fileNames).size).toBe(2);

        const fetched: string[] = [];
        for (const report of reports) {
          const response = await http(staticSourceUrl(report.artifact.source!.source_file_name!));
          expectStatus(response, 200);
          expect(sha256Hex(response.bytes)).toBe(report.artifact.source!.source_sha256);
          fetched.push(sha256Hex(response.bytes));
        }
        expect(new Set(fetched).size).toBe(2);

        const wasmHash = first.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-3"].wasm_hash!;
        const byWasmHash = await http(staticSourceUrl(`${wasmHash}.tar.gz`));
        expect([403, 404]).toContain(byWasmHash.status);

        const status = await requireStatusObject(wasmHash);
        const identity = await ownVerifierIdentity();
        const ours = status.source_code_verifications.filter((entry) => isOwnEntry(entry, identity));
        expect(ours).toHaveLength(1);
      },
      2 * env.jobTimeoutMs + 120_000
    );
  }
);
