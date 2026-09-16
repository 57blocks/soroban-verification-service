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

/**
 * An in-memory `ResultStorage` whose conditional write can be made to lose, which the filesystem backend
 * cannot: its own per-path lock serialises same-process writers, so nothing there ever reaches the re-read.
 * `onConflict` stands in for the other replica, mutating the store while this caller is losing to it.
 */
class RacingStorage implements ResultStorage {
  readonly kind = "filesystem" as const;
  readonly publicRoot = OURS.url;
  readonly crossProcessAtomicWrites = true;
  readonly objects = new Map<string, { text: string; version: number }>();
  /** Conditional writes still to be refused, newest attempt first. */
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

/** Appends a source URI straight into the stored bytes — the competing writer, not going through the helper. */
function otherWriterAppends(storage: RacingStorage, url: string): void {
  const held = storage.objects.get(KEY);
  if (!held) throw new Error("competing writer found no document");
  const document = JSON.parse(held.text);
  const entry = document.source_code_verifications[0];
  const present: { url: string }[] = entry.verified_source_code_uris ?? [];
  if (present.some((uri) => uri.url === url)) return; // idempotent, like the writer it stands in for
  entry.verified_source_code_uris = [...present, { location: "verifier_self_storage", url }];
  storage.objects.set(KEY, { text: `${JSON.stringify(document, null, 2)}\n`, version: held.version + 1 });
}

/** Flips our stored entry to `verified` — the other replica winning the race rule 20 is about. */
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

async function main(): Promise<void> {
  const archiveUrl = "https://gateway.irys.xyz/tx-1";
  const competingUrl = `${OURS.url}/sources/${"b".repeat(64)}.tar.gz`;

  // A lost swap re-reads and re-runs the mutation against what the winner left, so both updates survive.
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

  // The real writer, same race: a refusal must not be reported as a settled outcome.
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

  // Losing every attempt is `conflict` — still owed, never mistaken for "nothing to do".
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

  // Rule 20 under the race it exists for. A mismatched publish loses the swap to a replica that installed a
  // `verified` entry; the retry re-decides against those bytes and declines. Deciding this before the swap —
  // which is what publish.service.ts used to do — reads a snapshot that the winner has already invalidated,
  // and the mismatched lands on top of the verified.
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
