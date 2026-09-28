import assert from "node:assert/strict";
import { appendArchiveReference, mutateWasmStatus } from "./publish.js";
import { buildWasmStatus, type BuildWasmStatusParams } from "./registry-status.js";
import { wasmStatusKey } from "./keys.js";
import type { ResultStorage, StorageVersion, StorageWriteResult } from "./storage-backend.js";

const WASM_HASH = "a".repeat(64);
const OURS = { name: "57Blocks Reference Verifier", url: "https://verify.example.com/public" };
const REPORT_SHA = "9".repeat(64);
const REPORT_URL = `${OURS.url}/reports/${REPORT_SHA}.json`;
const KEY = wasmStatusKey(WASM_HASH);

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

/** In-memory storage whose conditional write can be made to lose; the filesystem backend's lock never lets it. */
class RacingStorage implements ResultStorage {
  readonly kind = "filesystem" as const;
  readonly publicRoot = OURS.url;
  readonly crossProcessAtomicWrites = true;
  readonly objects = new Map<string, { text: string; version: number }>();
  conflictsLeft = 0;
  onConflict: (() => void) | undefined;
  attempts = 0;

  async readText(path: string): Promise<string | undefined> {
    return this.objects.get(path)?.text;
  }

  async writeText(path: string, content: string): Promise<void> {
    const version = (this.objects.get(path)?.version ?? 0) + 1;
    this.objects.set(path, { text: content, version });
  }

  async readTextVersioned(path: string): Promise<{ text: string; version: StorageVersion } | undefined> {
    const held = this.objects.get(path);
    return held ? { text: held.text, version: String(held.version) } : undefined;
  }

  async writeTextIfUnchanged(
    path: string,
    content: string,
    _contentType: string,
    expected: StorageVersion | null,
  ): Promise<StorageWriteResult> {
    this.attempts += 1;
    if (this.conflictsLeft > 0) {
      this.conflictsLeft -= 1;
      this.onConflict?.();
      return "conflict";
    }
    const held = this.objects.get(path);
    const actual = held ? String(held.version) : null;
    if (actual !== expected) return "conflict";
    await this.writeText(path, content);
    return "written";
  }

  async readBytes(): Promise<Uint8Array | undefined> {
    return undefined;
  }
  async writeBytes(): Promise<void> {}
  async exists(path: string): Promise<boolean> {
    return this.objects.has(path);
  }
  async list(): Promise<string[]> {
    return [...this.objects.keys()];
  }
}

function otherWriterAppends(storage: RacingStorage, url: string): void {
  const held = storage.objects.get(KEY);
  if (!held) throw new Error("competing writer found no document");
  const document = JSON.parse(held.text);
  const entry = document.source_code_verifications[0];
  const present: { url: string }[] = entry.verified_source_code_uris ?? [];
  if (present.some((uri) => uri.url === url)) return;
  entry.verified_source_code_uris = [...present, { location: "verifier_self_storage", url }];
  storage.objects.set(KEY, { text: `${JSON.stringify(document, null, 2)}\n`, version: held.version + 1 });
}

function otherWriterVerifies(storage: RacingStorage): void {
  const held = storage.objects.get(KEY)!;
  const document = JSON.parse(held.text);
  const entry = document.source_code_verifications[0];
  entry.status = "verified";
  delete entry.rebuilt_hash;
  storage.objects.set(KEY, { text: `${JSON.stringify(document, null, 2)}\n`, version: held.version + 1 });
}

function seed(params: BuildWasmStatusParams = baseParams()): RacingStorage {
  const built = buildWasmStatus(params);
  assert.equal(built.outcome, "write");
  const storage = new RacingStorage();
  storage.objects.set(KEY, {
    text: `${JSON.stringify((built as { document: unknown }).document, null, 2)}\n`,
    version: 1,
  });
  return storage;
}

function seedLegacyDocument(): RacingStorage {
  const storage = new RacingStorage();
  const document = {
    wasm_hash: WASM_HASH,
    updated_at: "2026-08-21T10:02:12.856Z",
    source_code_verifications: [
      {
        verifier: { name: OURS.name },
        status: "verified",
        out_of_band: true,
        bldimg: `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`,
        bldopt: ["--locked"],
        source_sha256: "b".repeat(64),
        processed_at: "2026-08-21T10:02:12.856Z",
        results_urls: [REPORT_URL, "https://gateway.irys.xyz/legacy-tx"],
      },
    ],
    schema_version: "1.0",
  };
  storage.objects.set(KEY, { text: `${JSON.stringify(document, null, 2)}\n`, version: 1 });
  return storage;
}

async function main(): Promise<void> {
  const archiveUrl = "https://gateway.irys.xyz/tx-1";
  const competingUrl = `${OURS.url}/sources/${"b".repeat(64)}.tar.gz`;

  {
    const storage = seedLegacyDocument();

    const result = await mutateWasmStatus(storage, WASM_HASH, (existing) => {
      assert.ok(existing, "the legacy document parsed");
      const build = buildWasmStatus({ ...baseParams(), existing });
      return build.outcome === "write" ? { write: build.document } : { skip: "superseded" };
    });

    assert.equal(result, "written", "a pre-SEP document is amendable, not `invalid-document`");

    const final = JSON.parse(storage.objects.get(KEY)!.text);
    assert.equal(final.schema, "stellar-verification-status");
    for (const entry of final.source_code_verifications) {
      for (const link of entry.results_urls ?? []) {
        assert.equal(typeof link, "object", `results_urls entry ${JSON.stringify(link)} is still a string`);
        assert.ok(link.url, "the upgraded link kept its url");
      }
    }
  }

  {
    const storage = seed();
    storage.conflictsLeft = 1;
    storage.onConflict = () => otherWriterAppends(storage, competingUrl);

    const seen: number[] = [];
    const result = await mutateWasmStatus(storage, WASM_HASH, (existing) => {
      seen.push(existing?.source_code_verifications[0].verified_source_code_uris?.length ?? 0);
      const entry = existing!.source_code_verifications[0];
      return {
        write: {
          ...existing,
          source_code_verifications: [
            {
              ...entry,
              results_urls: [
                ...(entry.results_urls ?? []),
                { type: "report", location: "arweave", url: archiveUrl, sha256: REPORT_SHA },
              ],
            },
          ],
        } as never,
      };
    });

    assert.equal(result, "written");
    assert.equal(storage.attempts, 2, "one refusal, then one that lands");
    assert.deepEqual(seen, [0, 1], "the retry re-read: the second pass saw the other writer's entry");

    const final = JSON.parse(storage.objects.get(KEY)!.text);
    const entry = final.source_code_verifications[0];
    assert.equal(entry.results_urls.length, 2, "our link");
    assert.deepEqual(
      entry.verified_source_code_uris,
      [{ location: "verifier_self_storage", url: competingUrl }],
      "and the other writer's, not clobbered by a stale snapshot",
    );
  }

  {
    const storage = seed();
    storage.conflictsLeft = 2;
    storage.onConflict = () => otherWriterAppends(storage, competingUrl);

    const result = await appendArchiveReference(storage, WASM_HASH, {
      reportUrl: REPORT_URL,
      reportSha256: REPORT_SHA,
      archiveUrl,
    });
    assert.equal(result, "written");
    const final = JSON.parse(storage.objects.get(KEY)!.text);
    assert.equal(final.source_code_verifications[0].results_urls.length, 2);
    assert.equal(final.source_code_verifications[0].verified_source_code_uris.length, 1);
  }

  {
    const storage = seed();
    storage.conflictsLeft = Number.MAX_SAFE_INTEGER;
    const before = storage.objects.get(KEY)!.text;

    const result = await appendArchiveReference(storage, WASM_HASH, {
      reportUrl: REPORT_URL,
      reportSha256: REPORT_SHA,
      archiveUrl,
    });
    assert.equal(result, "conflict");
    assert.equal(storage.attempts, 5, "bounded, not forever");
    assert.equal(storage.objects.get(KEY)!.text, before, "nothing was written");
  }

  {
    const mismatched = baseParams({ verdict: "mismatched", rebuiltHash: "1".repeat(64) });
    const storage = seed(mismatched);
    storage.conflictsLeft = 1;
    storage.onConflict = () => otherWriterVerifies(storage);

    const result = await mutateWasmStatus(storage, WASM_HASH, (existing) => {
      const build = buildWasmStatus({ ...mismatched, existing });
      return build.outcome === "write" ? { write: build.document } : { skip: "superseded" };
    });

    assert.equal(result, "superseded", "the verdict the winner published stands");
    const final = JSON.parse(storage.objects.get(KEY)!.text);
    assert.equal(final.source_code_verifications[0].status, "verified", "rule 20 held across the race");
    assert.equal(final.source_code_verifications[0].rebuilt_hash, undefined);
  }

  console.log(
    "mutateWasmStatus: a lost swap re-reads and re-decides, exhausting the retries is `conflict`, " +
      "and rule 20 is decided against the bytes the swap writes",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
