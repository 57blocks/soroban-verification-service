import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { registryVerificationStatuses, type PeerRegistryStatusObject } from "@scvs/core";
import {
  buildWasmStatus,
  findOwnEntry,
  parsePeerWasmStatus,
  validateWasmStatus,
  type BuildWasmStatusParams,
} from "./registry-status.js";
import { appendArchiveReference, appendVerifiedSourceCodeUri, mutateWasmStatus } from "./publish.js";
import { readWasmStatus } from "./read.js";
import { createResultStorage } from "./storage-backend.js";
import { wasmStatusKey } from "./keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const draftExamplesDir = resolve(here, "../../../test/fixtures/registry");
const sepExample = resolve(here, "../../../test/fixtures/registry-sep/200-verified.json");

const WASM_HASH = "a".repeat(64);
const OURS = { name: "57Blocks Reference Verifier", url: "https://verify.example.com/public" };
const PEER = { name: "Other Verifier", url: "https://other.example.org/results" };
const REPORT_SHA = "9".repeat(64);
const REPORT_URL = `${OURS.url}/reports/${REPORT_SHA}.json`;

/** Parsed links are class instances with own `undefined` keys, so `deepStrictEqual` must compare their JSON. */
const plain = (items: readonly unknown[] | undefined): unknown[] => JSON.parse(JSON.stringify(items ?? []));

function built(params: BuildWasmStatusParams) {
  const result = buildWasmStatus(params);
  assert.equal(result.outcome, "write", "expected a document, not a declined write");
  return (result as { outcome: "write"; document: ReturnType<typeof validateWasmStatus> }).document;
}

function baseParams(overrides: Partial<BuildWasmStatusParams> = {}): BuildWasmStatusParams {
  return {
    existing: undefined,
    wasmHash: WASM_HASH,
    verifier: OURS,
    verdict: "verified",
    recipeSource: "on_chain_metadata",
    imageTrustLevel: "sdf_trusted",
    sourceSha256: "b".repeat(64),
    processedAt: "2026-09-02T00:00:00Z",
    resultsUrls: [{ type: "report", url: REPORT_URL, sha256: REPORT_SHA }],
    ...overrides,
  };
}

const peerEntry = {
  verifier: PEER,
  status: "mismatched",
  recipe_source: "submitted",
  image_trust_level: "upstream_pinned",
  source_sha256: "c".repeat(64),
  rebuilt_hash: "d".repeat(64),
  processed_at: "2026-09-01T00:00:00Z",
  results_urls: [{ type: "report", url: `${PEER.url}/reports/${"e".repeat(64)}.json`, sha256: "e".repeat(64) }],
};

/** Its verifier must carry no `url`, or the legacy path is never exercised. */
const legacyDocument = {
  schema_version: "1.0",
  wasm_hash: WASM_HASH,
  updated_at: "2026-08-20T00:00:00Z",
  source_code_verifications: [
    {
      verifier: { name: OURS.name },
      status: "verified",
      out_of_band: false,
      bldimg: `docker.io/stellar/stellar-cli@sha256:${"1".repeat(64)}`,
      bldopt: ["--package=foo"],
      source_sha256: "b".repeat(64),
      processed_at: "2026-08-20T00:00:00Z",
      results_urls: [{ type: "report", url: REPORT_URL, sha256: REPORT_SHA }],
    },
  ],
};

async function main(): Promise<void> {
  const isKnownStatus = (value: string) => (registryVerificationStatuses as readonly string[]).includes(value);
  assert.equal(isKnownStatus("mismatched"), true);
  assert.equal(isKnownStatus("mismatch"), false);

  {
    const status = built(baseParams({ bldarg: ["contract", "build"], bldopt: ["--package=foo"] }));
    assert.equal(status.schema, "stellar-verification-status");
    assert.equal(status.schema_version, "1.0");
    assert.equal(status.wasm_hash, WASM_HASH);
    assert.equal(status.updated_at, "2026-09-02T00:00:00Z");
    assert.equal(status.source_code_verifications.length, 1);
    const entry = status.source_code_verifications[0];
    assert.deepEqual(entry.verifier, OURS);
    assert.equal(entry.status, "verified");
    assert.equal(entry.recipe_source, "on_chain_metadata");
    assert.equal(entry.image_trust_level, "sdf_trusted");
    assert.deepEqual(entry.bldarg, ["contract", "build"]);
    assert.equal(entry.rebuilt_hash, undefined);
    assert.equal("out_of_band" in entry, false, "the draft's boolean is not published");
    assert.deepEqual(plain(entry.results_urls), [{ type: "report", url: REPORT_URL, sha256: REPORT_SHA }]);
    validateWasmStatus(status);
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status, "no class instances leak into the document");
  }

  {
    const status = built(baseParams({ verdict: "mismatched", rebuiltHash: "f".repeat(64) }));
    assert.equal(status.source_code_verifications[0].rebuilt_hash, "f".repeat(64));
  }
  assert.throws(() => built(baseParams({ verdict: "mismatched", rebuiltHash: undefined })));

  assert.throws(() => built(baseParams({ resultsUrls: [{ type: "report", url: REPORT_URL }] })), /AU1/);

  {
    const a = built(baseParams({ bldopt: ["--locked=true", "--verbose=true"] }));
    const b = built(baseParams({ bldopt: ["--verbose=true", "--locked=true"] }));
    assert.deepEqual(a.source_code_verifications[0].bldopt, ["--locked=true", "--verbose=true"]);
    assert.deepEqual(b.source_code_verifications[0].bldopt, ["--verbose=true", "--locked=true"]);
  }

  const asPeerDoc = (doc: unknown): PeerRegistryStatusObject => {
    const parsed = parsePeerWasmStatus(JSON.parse(JSON.stringify(doc)));
    assert.ok(parsed, "fixture must parse as a peer document");
    return parsed;
  };

  {
    const verified = built(baseParams());
    const reVerified = built(
      baseParams({ existing: asPeerDoc(verified), sourceSha256: "c".repeat(64), processedAt: "2026-09-03T00:00:00Z" }),
    );
    assert.equal(reVerified.source_code_verifications[0].source_sha256, "c".repeat(64));
    assert.equal(reVerified.updated_at, "2026-09-03T00:00:00Z");
  }
  {
    const verified = built(baseParams());
    const existing = asPeerDoc(verified);
    const attempt = buildWasmStatus(baseParams({ existing, verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    assert.deepEqual(attempt, { outcome: "superseded" }, "row 3 declines to write rather than handing back a peer document");
  }
  {
    const mismatched = built(baseParams({ verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    const reVerified = built(baseParams({ existing: asPeerDoc(mismatched), verdict: "verified" }));
    assert.equal(reVerified.source_code_verifications[0].status, "verified");
    assert.equal(reVerified.source_code_verifications[0].rebuilt_hash, undefined);
  }
  {
    const mismatched = built(baseParams({ verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    const again = built(
      baseParams({ existing: asPeerDoc(mismatched), verdict: "mismatched", rebuiltHash: "2".repeat(64), sourceSha256: "c".repeat(64) }),
    );
    assert.equal(again.source_code_verifications[0].rebuilt_hash, "2".repeat(64));
  }

  {
    const withPeerFirst = asPeerDoc({
      ...legacyDocument,
      schema: "stellar-verification-status",
      source_code_verifications: [peerEntry, built(baseParams()).source_code_verifications[0]],
    });
    assert.equal(findOwnEntry(withPeerFirst, OURS)?.verifier.url, OURS.url);

    const blocked = buildWasmStatus(baseParams({ existing: withPeerFirst, verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    assert.deepEqual(blocked, { outcome: "superseded" });

    assert.throws(
      () =>
        built(
          baseParams({ existing: withPeerFirst, sourceSha256: "c".repeat(64), processedAt: "2026-09-04T00:00:00Z" }),
        ),
      "a document carrying another verifier's entry cannot be republished under a one-entry schema",
    );
  }
  {
    const renamed = built(baseParams({ verifier: { name: "57Blocks (renamed)", url: OURS.url } }));
    const merged = built(baseParams({ existing: asPeerDoc(renamed), sourceSha256: "c".repeat(64) }));
    assert.equal(merged.source_code_verifications.length, 1, "same url ⇒ same verifier ⇒ one entry");
    assert.throws(
      () =>
        built(
          baseParams({
            existing: asPeerDoc(renamed),
            verifier: { name: "57Blocks (renamed)", url: "https://elsewhere.example/public" },
          }),
        ),
      "a foreign entry cannot be carried into a document this verifier publishes",
    );
  }

  {
    const existing = asPeerDoc(legacyDocument);
    assert.equal(findOwnEntry(existing, OURS)?.status, "verified", "a legacy entry with no url is matched by name");
    const blocked = buildWasmStatus(baseParams({ existing, verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    assert.deepEqual(blocked, { outcome: "superseded" }, "row 3 protects a legacy verified entry too");

    assert.equal(
      findOwnEntry(existing, { name: "57Blocks (renamed)", url: OURS.url })?.status,
      "verified",
      "a renamed verifier still owns the entry whose links are under its own root",
    );

    const reVerified = built(baseParams({ existing, sourceSha256: "c".repeat(64) }));
    assert.equal(reVerified.schema, "stellar-verification-status");
    assert.equal(reVerified.source_code_verifications.length, 1);
    assert.deepEqual(reVerified.source_code_verifications[0].verifier, OURS);
  }

  {
    const files = (await readdir(draftExamplesDir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 5);
    for (const name of files) {
      const raw = JSON.parse(await readFile(join(draftExamplesDir, name), "utf8"));
      assert.ok(parsePeerWasmStatus(raw), `${name} must parse as a peer document`);
      assert.throws(() => validateWasmStatus(raw), `${name} is not something we would publish`);
    }
    validateWasmStatus(JSON.parse(await readFile(sepExample, "utf8")));
  }

  const root = await mkdtemp(join(tmpdir(), "registry-status-test-"));
  const storage = createResultStorage({ kind: "filesystem", root, publicRoot: OURS.url });
  const gatewayUrl = (tx: string) => `https://gateway.irys.xyz/${tx}`;
  const writeDoc = async (doc: unknown) =>
    storage.writeText(wasmStatusKey(WASM_HASH), `${JSON.stringify(doc, null, 2)}\n`, "application/json; charset=utf-8");

  assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("x") }), "absent");

  await writeDoc(built(baseParams()));
  {
    const before = await readWasmStatus(storage, WASM_HASH);
    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-1") }), "written");
    const after = await readWasmStatus(storage, WASM_HASH);
    assert.ok(after && before);
    assert.deepEqual(plain(after.source_code_verifications[0].results_urls), [
      { type: "report", url: REPORT_URL, sha256: REPORT_SHA },
      { type: "report", location: "arweave", url: gatewayUrl("tx-1"), sha256: REPORT_SHA },
    ]);
    assert.notEqual(after.updated_at, before.updated_at, "a backfill advances the document's clock");
    assert.equal(after.source_code_verifications[0].status, "verified", "verdict-bearing fields are untouched");
    validateWasmStatus(JSON.parse((await storage.readText(wasmStatusKey(WASM_HASH)))!));

    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-1") }), "already-present");
    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-2") }), "written");
    const afterSecond = await readWasmStatus(storage, WASM_HASH);
    assert.equal(afterSecond?.source_code_verifications[0].results_urls?.length, 3);

    const staleReport = `${OURS.url}/reports/${"7".repeat(64)}.json`;
    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: staleReport, reportSha256: "7".repeat(64), archiveUrl: gatewayUrl("stale") }), "superseded");
  }

  await writeDoc(legacyDocument);
  {
    assert.equal(
      await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-1") }),
      "unrepresentable",
      "a legacy verdict cannot be rewritten conformantly without its trust level",
    );
    assert.equal(
      await appendArchiveReference(storage, WASM_HASH, {
        reportUrl: REPORT_URL,
        reportSha256: REPORT_SHA,
        archiveUrl: gatewayUrl("tx-1"),
        legacyCustody: { imageTrustLevel: "sdf_trusted" },
      }),
      "written",
    );
    const upgraded = await readWasmStatus(storage, WASM_HASH);
    assert.ok(upgraded);
    assert.equal(upgraded.schema, "stellar-verification-status");
    const entry = upgraded.source_code_verifications[0];
    assert.equal(entry.verifier.url, OURS.url, "the identity is recovered from our own root, not invented");
    assert.equal(entry.verifier.name, OURS.name);
    assert.equal(entry.recipe_source, "on_chain_metadata", "out_of_band: false ⇒ on_chain_metadata");
    assert.equal(entry.image_trust_level, "sdf_trusted");
    assert.deepEqual(plain(entry.results_urls), [
      { type: "report", url: REPORT_URL, sha256: REPORT_SHA },
      { type: "report", location: "arweave", url: gatewayUrl("tx-1"), sha256: REPORT_SHA },
    ]);
    const bytes = JSON.parse((await storage.readText(wasmStatusKey(WASM_HASH)))!);
    assert.equal("out_of_band" in bytes.source_code_verifications[0], false, "the draft's boolean is gone from the bytes");
    validateWasmStatus(bytes);
  }

  await writeDoc(built(baseParams()));
  {
    const sourceUrl = `${OURS.url}/sources/${"b".repeat(64)}.tar.gz`;
    const sourceCodeUri = { location: "verifier_self_storage" as const, url: sourceUrl };
    assert.equal(await appendVerifiedSourceCodeUri(storage, WASM_HASH, { reportUrl: REPORT_URL, sourceCodeUri }), "written");
    assert.equal(await appendVerifiedSourceCodeUri(storage, WASM_HASH, { reportUrl: REPORT_URL, sourceCodeUri }), "already-present");
    const after = await readWasmStatus(storage, WASM_HASH);
    assert.deepEqual(plain(after?.source_code_verifications[0].verified_source_code_uris), [sourceCodeUri]);
    assert.equal(
      await appendVerifiedSourceCodeUri(storage, WASM_HASH, { reportUrl: `${OURS.url}/reports/${"7".repeat(64)}.json`, sourceCodeUri }),
      "superseded",
    );
  }

  {
    const concurrentHash = "c".repeat(64);
    const reportUrl = `${OURS.url}/reports/${REPORT_SHA}.json`;
    await storage.writeText(
      wasmStatusKey(concurrentHash),
      `${JSON.stringify(built(baseParams({ wasmHash: concurrentHash })), null, 2)}\n`,
      "application/json; charset=utf-8",
    );
    const sourceUrl = `${OURS.url}/sources/${"b".repeat(64)}.tar.gz`;
    const concurrentSourceCodeUri = { location: "verifier_self_storage" as const, url: sourceUrl };
    const [wroteArchive, wroteSource] = await Promise.all([
      appendArchiveReference(storage, concurrentHash, { reportUrl, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-c") }),
      appendVerifiedSourceCodeUri(storage, concurrentHash, { reportUrl, sourceCodeUri: concurrentSourceCodeUri }),
    ]);
    assert.equal(wroteArchive, "written");
    assert.equal(wroteSource, "written");
    const final = await readWasmStatus(storage, concurrentHash);
    assert.equal(final?.source_code_verifications[0].results_urls?.length, 2);
    assert.deepEqual(plain(final?.source_code_verifications[0].verified_source_code_uris), [concurrentSourceCodeUri]);
  }

  {
    const corruptHash = "d".repeat(64);
    const corrupt = "{ this is not a document\n";
    await storage.writeText(wasmStatusKey(corruptHash), corrupt, "application/json; charset=utf-8");
    assert.equal(
      await appendArchiveReference(storage, corruptHash, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-x") }),
      "invalid-document",
    );
    assert.equal(await storage.readText(wasmStatusKey(corruptHash)), corrupt, "the stored bytes are untouched");

    const wrongShape = `${JSON.stringify({ schema: "something-else" }, null, 2)}\n`;
    await storage.writeText(wasmStatusKey(corruptHash), wrongShape, "application/json; charset=utf-8");
    assert.equal(
      await appendVerifiedSourceCodeUri(storage, corruptHash, {
        reportUrl: REPORT_URL,
        sourceCodeUri: { location: "verifier_self_storage", url: `${OURS.url}/sources/${"e".repeat(64)}.tar.gz` },
      }),
      "invalid-document",
    );
    assert.equal(await storage.readText(wasmStatusKey(corruptHash)), wrongShape);
  }

  {
    const freshHash = "e".repeat(64);
    const fresh = built(baseParams({ wasmHash: freshHash }));
    assert.equal(await mutateWasmStatus(storage, freshHash, (existing) => {
      assert.equal(existing, undefined, "an absent object reaches the mutation as undefined");
      return { write: fresh };
    }), "written");
    validateWasmStatus(JSON.parse((await storage.readText(wasmStatusKey(freshHash)))!));

    assert.equal(await mutateWasmStatus(storage, freshHash, () => ({ skip: "superseded" })), "superseded");
  }

  console.log(
    "Registry status object: SEP-shape assembly, the verifier-keyed merge table, legacy upgrade on write, " +
      "and the two append-style writers (append, updated_at, superseded, unrepresentable, invalid-document, " +
      "same-process concurrency) passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
