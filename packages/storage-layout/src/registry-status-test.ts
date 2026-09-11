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
import { appendArchiveReference, appendVerifiedSourceCodeUri } from "./publish.js";
import { readWasmStatus } from "./read.js";
import { createResultStorage } from "./storage-backend.js";
import { wasmStatusKey } from "./keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const draftExamplesDir = resolve(here, "../../../test/fixtures/registry");
const sepExample = resolve(here, "../../../test/fixtures/registry-sep/200-verified.json");

// Plain-script test, following clients/sdk's src/sdk-test.ts convention rather than Jest.

const WASM_HASH = "a".repeat(64);
const OURS = { name: "57Blocks Reference Verifier", url: "https://verify.example.com/public" };
const PEER = { name: "Other Verifier", url: "https://other.example.org/results" };
const REPORT_SHA = "9".repeat(64);
const REPORT_URL = `${OURS.url}/reports/${REPORT_SHA}.json`;

/**
 * `@Type` on the consumer entry's link fields makes these class instances since 2026-09-10:
 * `deepStrictEqual` compares prototypes, and `plainToInstance` materialises a declared-but-absent
 * optional as an own `undefined` key. `JSON.stringify` drops both, so the published bytes are unchanged
 * — this is what the assertions below compare.
 */
const plain = (items: readonly unknown[] | undefined): unknown[] => JSON.parse(JSON.stringify(items ?? []));

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

/** A peer's SEP-shape entry for the same hash, as an aggregate or a relayed document would carry it. */
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

/** Carrying a url here made the whole legacy path below pass without ever exercising the case it is for. */
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
      // Structured since 2026-09-10: the consumer shape no longer reads a bare-string link, so a document
      // carrying one cannot be read at all and therefore cannot be upgraded either. What stays upgradeable
      // is a document like this one — no `schema`, draft custody vocabulary, links already structured.
      results_urls: [{ type: "report", url: REPORT_URL, sha256: REPORT_SHA }],
    },
  ],
};

async function main(): Promise<void> {
  // registryVerificationStatuses: exact spelling — the typo the real schema's enum exists to catch.
  const isKnownStatus = (value: string) => (registryVerificationStatuses as readonly string[]).includes(value);
  assert.equal(isKnownStatus("mismatched"), true);
  assert.equal(isKnownStatus("mismatch"), false);

  // ---- assembly -----------------------------------------------------------------------------------
  {
    const status = buildWasmStatus(baseParams({ bldarg: ["contract", "build"], bldopt: ["--package=foo"] }));
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
    validateWasmStatus(status); // strict round-trip
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status, "no class instances leak into the document");
  }

  // A `mismatched` verdict carries rebuilt_hash; without one, assembly throws before any write.
  {
    const status = buildWasmStatus(baseParams({ verdict: "mismatched", rebuiltHash: "f".repeat(64) }));
    assert.equal(status.source_code_verifications[0].rebuilt_hash, "f".repeat(64));
  }
  assert.throws(() => buildWasmStatus(baseParams({ verdict: "mismatched", rebuiltHash: undefined })));

  // AU1 — a link we publish without a sha256 is refused at assembly.
  assert.throws(() => buildWasmStatus(baseParams({ resultsUrls: [{ type: "report", url: REPORT_URL }] })), /AU1/);

  // bldopt order is preserved, never sorted; bldarg likewise.
  {
    const a = buildWasmStatus(baseParams({ bldopt: ["--locked=true", "--verbose=true"] }));
    const b = buildWasmStatus(baseParams({ bldopt: ["--verbose=true", "--locked=true"] }));
    assert.deepEqual(a.source_code_verifications[0].bldopt, ["--locked=true", "--verbose=true"]);
    assert.deepEqual(b.source_code_verifications[0].bldopt, ["--verbose=true", "--locked=true"]);
  }

  // ---- the merge table, keyed by verifier ---------------------------------------------------------
  const asPeerDoc = (doc: unknown): PeerRegistryStatusObject => {
    const parsed = parsePeerWasmStatus(JSON.parse(JSON.stringify(doc)));
    assert.ok(parsed, "fixture must parse as a peer document");
    return parsed;
  };

  // Row 4: verified → verified from a different source: the newer verified wins.
  {
    const verified = buildWasmStatus(baseParams());
    const reVerified = buildWasmStatus(
      baseParams({ existing: asPeerDoc(verified), sourceSha256: "c".repeat(64), processedAt: "2026-09-03T00:00:00Z" }),
    );
    assert.equal(reVerified.source_code_verifications[0].source_sha256, "c".repeat(64));
    assert.equal(reVerified.updated_at, "2026-09-03T00:00:00Z");
  }
  // Row 3: verified → mismatched: the existing verified stands, same reference.
  {
    const verified = buildWasmStatus(baseParams());
    const existing = asPeerDoc(verified);
    const attempt = buildWasmStatus(baseParams({ existing, verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    assert.equal(attempt, existing as unknown, "row 3 returns the existing document untouched");
  }
  // Row 2: mismatched → verified.
  {
    const mismatched = buildWasmStatus(baseParams({ verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    const reVerified = buildWasmStatus(baseParams({ existing: asPeerDoc(mismatched), verdict: "verified" }));
    assert.equal(reVerified.source_code_verifications[0].status, "verified");
    assert.equal(reVerified.source_code_verifications[0].rebuilt_hash, undefined);
  }
  // Row 5: mismatched → mismatched from a different source: the newer one.
  {
    const mismatched = buildWasmStatus(baseParams({ verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    const again = buildWasmStatus(
      baseParams({ existing: asPeerDoc(mismatched), verdict: "mismatched", rebuiltHash: "2".repeat(64), sourceSha256: "c".repeat(64) }),
    );
    assert.equal(again.source_code_verifications[0].rebuilt_hash, "2".repeat(64));
  }

  // Keyed by verifier, not by position: a document carrying another verifier's entry keeps it verbatim, and the
  // table is applied to OUR entry wherever it sits.
  {
    const withPeerFirst = asPeerDoc({
      ...legacyDocument,
      schema: "stellar-verification-status",
      source_code_verifications: [peerEntry, buildWasmStatus(baseParams()).source_code_verifications[0]],
    });
    assert.equal(findOwnEntry(withPeerFirst, OURS)?.verifier.url, OURS.url);

    // Row 3 still holds for our entry at index 1…
    const blocked = buildWasmStatus(baseParams({ existing: withPeerFirst, verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    assert.equal(blocked, withPeerFirst as unknown);

    // …and a re-verification refuses rather than publishing the two-entry document it would have to.
    // Until 2026-09-10 this asserted the merge: the peer's entry untouched at index 0, ours rewritten at
    // index 1. `maxItems: 1` removed the shape that result had to take, so the writer stops instead —
    // refusing to publish is the only remaining honest option, since the alternative is dropping a claim
    // that is not ours to drop.
    assert.throws(
      () =>
        buildWasmStatus(
          baseParams({ existing: withPeerFirst, sourceSha256: "c".repeat(64), processedAt: "2026-09-04T00:00:00Z" }),
        ),
      "a document carrying another verifier's entry cannot be republished under a one-entry schema",
    );
  }
  // The identity is the url, not the display name.
  {
    const renamed = buildWasmStatus(baseParams({ verifier: { name: "57Blocks (renamed)", url: OURS.url } }));
    const merged = buildWasmStatus(baseParams({ existing: asPeerDoc(renamed), sourceSha256: "c".repeat(64) }));
    assert.equal(merged.source_code_verifications.length, 1, "same url ⇒ same verifier ⇒ one entry");
    // Same name, different url ⇒ a different verifier, so its entry is not merged into ours. What used to
    // be asserted here is that the result was a two-entry document; since 2026-09-10 a result root holds one
    // entry and the producer shape bounds it, so the writer refuses instead of publishing something the
    // SEP's own schema rejects. The identity rule is what is under test either way.
    assert.throws(
      () =>
        buildWasmStatus(
          baseParams({
            existing: asPeerDoc(renamed),
            verifier: { name: "57Blocks (renamed)", url: "https://elsewhere.example/public" },
          }),
        ),
      "a foreign entry cannot be carried into a document this verifier publishes",
    );
  }

  // ---- legacy (draft-shape) documents -------------------------------------------------------------
  // Our pre-cutover document reads back tolerantly, and a new publish rewrites it in the SEP shape.
  {
    const existing = asPeerDoc(legacyDocument);
    assert.equal(findOwnEntry(existing, OURS)?.status, "verified", "a legacy entry with no url is matched by name");
    const blocked = buildWasmStatus(baseParams({ existing, verdict: "mismatched", rebuiltHash: "1".repeat(64) }));
    assert.equal(blocked, existing as unknown, "row 3 protects a legacy verified entry too");

    // `display_name` is an operator-facing label. The links still sit under our root, and that is enough.
    assert.equal(
      findOwnEntry(existing, { name: "57Blocks (renamed)", url: OURS.url })?.status,
      "verified",
      "a renamed verifier still owns the entry whose links are under its own root",
    );

    const reVerified = buildWasmStatus(baseParams({ existing, sourceSha256: "c".repeat(64) }));
    assert.equal(reVerified.schema, "stellar-verification-status");
    assert.equal(reVerified.source_code_verifications.length, 1);
    assert.deepEqual(reVerified.source_code_verifications[0].verifier, OURS);
  }

  // Every draft example still reads as a PEER document — except the one whose links are bare strings, which
  // stopped being readable on 2026-09-10 and is the whole point of that change.
  {
    const files = (await readdir(draftExamplesDir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 5);
    for (const name of files) {
      const raw = JSON.parse(await readFile(join(draftExamplesDir, name), "utf8"));
      const readable = parsePeerWasmStatus(raw);
      if (name === "200-verified.json") assert.equal(readable, undefined, `${name} carries bare-string links`);
      else assert.ok(readable, `${name} must parse as a peer document`);
      assert.throws(() => validateWasmStatus(raw), `${name} is not something we would publish`);
    }
    validateWasmStatus(JSON.parse(await readFile(sepExample, "utf8")));
  }

  // ---- append-style writers against a real filesystem ResultStorage -------------------------------
  const root = await mkdtemp(join(tmpdir(), "registry-status-test-"));
  const storage = createResultStorage({ kind: "filesystem", root, publicRoot: OURS.url });
  const gatewayUrl = (tx: string) => `https://gateway.irys.xyz/${tx}`;
  const writeDoc = async (doc: unknown) =>
    storage.writeText(wasmStatusKey(WASM_HASH), `${JSON.stringify(doc, null, 2)}\n`, "application/json; charset=utf-8");

  // Absent document: no-op.
  assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("x") }), false);

  // SEP-shape document: the archive link is appended with the report's sha256 and updated_at advances.
  await writeDoc(buildWasmStatus(baseParams()));
  {
    const before = await readWasmStatus(storage, WASM_HASH);
    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-1") }), true);
    const after = await readWasmStatus(storage, WASM_HASH);
    assert.ok(after && before);
    assert.deepEqual(plain(after.source_code_verifications[0].results_urls), [
      { type: "report", url: REPORT_URL, sha256: REPORT_SHA },
      { type: "report", location: "arweave", url: gatewayUrl("tx-1"), sha256: REPORT_SHA },
    ]);
    assert.notEqual(after.updated_at, before.updated_at, "a backfill advances the document's clock");
    assert.equal(after.source_code_verifications[0].status, "verified", "verdict-bearing fields are untouched");
    validateWasmStatus(JSON.parse((await storage.readText(wasmStatusKey(WASM_HASH)))!)); // the bytes on disk, not a parsed instance

    // Idempotent: the same link again is a no-op; a different archive URL appends rather than resets.
    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-1") }), false);
    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-2") }), true);
    const afterSecond = await readWasmStatus(storage, WASM_HASH);
    assert.equal(afterSecond?.source_code_verifications[0].results_urls?.length, 3);

    // Stale report URL (a newer verification replaced the entry): no-op.
    const staleReport = `${OURS.url}/reports/${"7".repeat(64)}.json`;
    assert.equal(await appendArchiveReference(storage, WASM_HASH, { reportUrl: staleReport, reportSha256: "7".repeat(64), archiveUrl: gatewayUrl("stale") }), false);
  }

  // Legacy document: upgraded on write when the caller supplies the trust level, left alone otherwise.
  await writeDoc(legacyDocument);
  {
    assert.equal(
      await appendArchiveReference(storage, WASM_HASH, { reportUrl: REPORT_URL, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-1") }),
      false,
      "a legacy verdict cannot be rewritten conformantly without its trust level",
    );
    assert.equal(
      await appendArchiveReference(storage, WASM_HASH, {
        reportUrl: REPORT_URL,
        reportSha256: REPORT_SHA,
        archiveUrl: gatewayUrl("tx-1"),
        legacyCustody: { imageTrustLevel: "sdf_trusted" },
      }),
      true,
    );
    const upgraded = await readWasmStatus(storage, WASM_HASH);
    assert.ok(upgraded);
    assert.equal(upgraded.schema, "stellar-verification-status");
    const entry = upgraded.source_code_verifications[0];
    // Recovered from the root we published under, which is what the writer matched the entry by.
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

  // appendVerifiedSourceCodeUri: same anchoring and append semantics.
  await writeDoc(buildWasmStatus(baseParams()));
  {
    const sourceUrl = `${OURS.url}/sources/${"b".repeat(64)}.tar.gz`;
    const sourceCodeUri = { location: "verifier_self_storage" as const, url: sourceUrl };
    assert.equal(await appendVerifiedSourceCodeUri(storage, WASM_HASH, { reportUrl: REPORT_URL, sourceCodeUri }), true);
    assert.equal(await appendVerifiedSourceCodeUri(storage, WASM_HASH, { reportUrl: REPORT_URL, sourceCodeUri }), false);
    const after = await readWasmStatus(storage, WASM_HASH);
    assert.deepEqual(plain(after?.source_code_verifications[0].verified_source_code_uris), [sourceCodeUri]);
    assert.equal(
      await appendVerifiedSourceCodeUri(storage, WASM_HASH, { reportUrl: `${OURS.url}/reports/${"7".repeat(64)}.json`, sourceCodeUri }),
      false,
    );
  }

  // Concurrent append-style writers on the SAME hash serialise; neither write is lost.
  {
    const concurrentHash = "c".repeat(64);
    const reportUrl = `${OURS.url}/reports/${REPORT_SHA}.json`;
    await storage.writeText(
      wasmStatusKey(concurrentHash),
      `${JSON.stringify(buildWasmStatus(baseParams({ wasmHash: concurrentHash })), null, 2)}\n`,
      "application/json; charset=utf-8",
    );
    const sourceUrl = `${OURS.url}/sources/${"b".repeat(64)}.tar.gz`;
    const concurrentSourceCodeUri = { location: "verifier_self_storage" as const, url: sourceUrl };
    const [wroteArchive, wroteSource] = await Promise.all([
      appendArchiveReference(storage, concurrentHash, { reportUrl, reportSha256: REPORT_SHA, archiveUrl: gatewayUrl("tx-c") }),
      appendVerifiedSourceCodeUri(storage, concurrentHash, { reportUrl, sourceCodeUri: concurrentSourceCodeUri }),
    ]);
    assert.equal(wroteArchive, true);
    assert.equal(wroteSource, true);
    const final = await readWasmStatus(storage, concurrentHash);
    assert.equal(final?.source_code_verifications[0].results_urls?.length, 2);
    assert.deepEqual(plain(final?.source_code_verifications[0].verified_source_code_uris), [concurrentSourceCodeUri]);
  }

  console.log(
    "Registry status object: SEP-shape assembly, the verifier-keyed merge table, legacy upgrade on write, " +
      "and the two append-style writers (append, updated_at, stale-report no-op, concurrency) passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
