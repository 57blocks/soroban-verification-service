import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  newClient,
  statusObjectUrl,
  validateStatusObject,
  displayStatusOf,
  RegistryDocumentError,
  type RegistryVerification,
  type PeerTrustedVerifiersList,
} from "../src/index.js";

// The fixtures under test/fixtures/registry are the draft's own worked examples, copied verbatim, so "we read
// what the draft publishes" is checkable rather than asserted.

const here = dirname(fileURLToPath(import.meta.url));
const registryFixtures = resolve(here, "../../../test/fixtures/registry");

const ORIGIN = "https://verify.example.test";
const HASH = "cb2fc3a1b4d5e6f7081928374655647382910abcdef0123456789abcdef01234";

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(registryFixtures, name), "utf8")) as Record<string, unknown>;
}

/**
 * The draft example every other test here builds on. Not `200-verified.json`: its `results_urls` are bare
 * strings, which stopped being readable on 2026-09-10 — `draftExamplesParse` is where that is pinned.
 */
const READABLE_DRAFT = "200-out-of-band.json";

/** The one example whose links are bare strings, and therefore the one that no longer reads. */
const BARE_STRING_LINKS = "200-verified.json";

/**
 * Every worked example in the draft parses, except the one carrying a link shape we stopped accepting; if
 * one of the others fails, our shape has drifted from the draft.
 */
async function draftExamplesParse(): Promise<void> {
  const files = (await readdir(registryFixtures)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 5, `expected the draft's examples, found ${files.length}`);
  for (const name of files) {
    const document = await fixture(name);
    if (name === BARE_STRING_LINKS) {
      assert.throws(() => validateStatusObject(document, name), `${name} carries bare-string links`);
      continue;
    }
    const parsed = validateStatusObject(document, name);
    assert.equal(parsed.schema_version, "1.0", `${name} lost its schema_version`);
    assert.ok(parsed.source_code_verifications.length >= 1, `${name} parsed with no verifications`);
  }
}

/** Unknown fields tolerated by default; the base projection on request. */
async function validationModes(): Promise<void> {
  const extended = {
    ...(await fixture(READABLE_DRAFT)),
    x_extensions: ["some-peer.extension/1.0"], // a peer's declaration: tolerated, never emitted
    source_sha256: "a".repeat(64), // a field the 1.0 schema has no room for
  };

  // Both tolerated: a real document carrying extensions must still be readable.
  const relaxed = validateStatusObject(extended, "extended");
  assert.equal(relaxed.wasm_hash, HASH);

  // Projects first, so a closed-schema consumer gets a document that passes rather than an error.
  const strict = validateStatusObject(extended, "extended", "strict-base");
  assert.equal(strict.wasm_hash, HASH);
  assert.equal((strict as unknown as Record<string, unknown>).x_extensions, undefined);
  assert.equal((strict as unknown as Record<string, unknown>).source_sha256, undefined);
  // ...and projecting must not have mutated the caller's object.
  assert.deepEqual(extended.x_extensions, ["some-peer.extension/1.0"]);

  const newStatus = { ...(await fixture(READABLE_DRAFT)) };
  (newStatus.source_code_verifications as Record<string, unknown>[])[0].status = "mismatch"; // ours, not the draft's
  assert.equal(displayStatusOf(validateStatusObject(newStatus, "new-status").source_code_verifications[0]), "unverified");
  assert.equal(displayStatusOf(validateStatusObject(newStatus, "new-status", "strict-base").source_code_verifications[0]), "unverified");

  // Wrong in the base shape still fails in both modes: the relaxation is about unknown fields and enum values,
  // never about structure.
  const badShape = { ...(await fixture(READABLE_DRAFT)) };
  (badShape.source_code_verifications as Record<string, unknown>[])[0].verifier = "not an object";
  assert.throws(() => validateStatusObject(badShape, "bad-shape"), RegistryDocumentError);
  assert.throws(() => validateStatusObject(badShape, "bad-shape", "strict-base"), RegistryDocumentError);

  assert.throws(() => validateStatusObject("not an object", "junk"), RegistryDocumentError);
  assert.throws(() => validateStatusObject([], "array"), RegistryDocumentError);
}

/** An unrecognised `status` displays as `unverified`; an aggregate still carries what was said. */
function unknownStatusCoercion(): void {
  assert.equal(displayStatusOf({ status: "verified" } as RegistryVerification), "verified");
  assert.equal(displayStatusOf({ status: "mismatched" } as RegistryVerification), "mismatched");
  assert.equal(
    displayStatusOf({ status: "something-the-draft-added-later" } as unknown as RegistryVerification),
    "unverified",
  );
}

/** The key is `wasms/<hash>.json`, lowercase, with no `network` anywhere. */
function keyConvention(): void {
  assert.equal(statusObjectUrl(`${ORIGIN}/`, HASH), `${ORIGIN}/wasms/${HASH}.json`);
  // A hash arrives uppercase from plenty of tools; the layout is lowercase hex.
  assert.equal(statusObjectUrl(ORIGIN, HASH.toUpperCase()), `${ORIGIN}/wasms/${HASH}.json`);

  // A missing trailing slash must not escape to the parent: plain resolution would read another verifier's
  // root, or the origin's own.
  assert.equal(statusObjectUrl(`${ORIGIN}/verifier-a`, HASH), `${ORIGIN}/verifier-a/wasms/${HASH}.json`);
  assert.equal(statusObjectUrl(`${ORIGIN}/verifier-a/`, HASH), `${ORIGIN}/verifier-a/wasms/${HASH}.json`);

  // Query and fragment are dropped, not slash-appended: appending left the path behind and resolved to the
  // origin root — the same escape this normalization prevents.
  assert.equal(statusObjectUrl(`${ORIGIN}/verifier-a?a=1`, HASH), `${ORIGIN}/verifier-a/wasms/${HASH}.json`);
  assert.equal(statusObjectUrl(`${ORIGIN}/verifier-a#frag`, HASH), `${ORIGIN}/verifier-a/wasms/${HASH}.json`);

  assert.ok(!statusObjectUrl(`${ORIGIN}/`, HASH).includes("mainnet"));
}

type Verifier = {
  id: string;
  display_name: string;
  url: string;
  manifest_url: string;
  bulk_load_url: string;
  status: string;
};

function tvl(...verifiers: Verifier[]): PeerTrustedVerifiersList {
  return {
    schema: "stellar-trusted-verifiers-list-v1",
    verifiers: verifiers as PeerTrustedVerifiersList["verifiers"],
    updated_at: "2026-08-05T00:00:00.000Z",
  };
}

/**
 * `bulk_load_url` is whatever the TVL entry says — the SDK fetches it and never builds the path — so a repath
 * can never fail these tests.
 */
function verifier(id: string, host: string, status = "active"): Verifier {
  return {
    id,
    display_name: `${id} display`,
    url: `https://${host}/`,
    manifest_url: `https://${host}/verifier-manifest.json`,
    bulk_load_url: `https://${host}/api/verification/v1/wasms`,
    status,
  };
}

/** One verifier per outcome. The rule being tested is that nothing is dropped and nothing throws. */
async function aggregationDegradesHonestly(): Promise<void> {
  const good = await fixture(READABLE_DRAFT);
  const list = tvl(
    verifier("good", "good.test"),
    verifier("absent", "absent.test"),
    verifier("garbage", "garbage.test"),
    verifier("unreachable", "unreachable.test"),
    verifier("paused-by-operator", "paused.test", "paused"),
    // Its url is a private-range literal, so the policy refuses it before any request.
    {
      id: "off-policy",
      display_name: "off-policy display",
      url: "https://10.1.2.3/",
      manifest_url: "https://10.1.2.3/verifier-manifest.json",
      bulk_load_url: "https://10.1.2.3/api/verification/v1/wasms",
      status: "active",
    },
  );

  const requested: string[] = [];
  const client = newClient({
    tvl: list,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith("https://good.test/")) return new Response(JSON.stringify(good), { status: 200 });
      if (url.startsWith("https://absent.test/")) return new Response("{}", { status: 404 });
      if (url.startsWith("https://garbage.test/")) {
        return new Response(JSON.stringify({ schema_version: "9.9" }), { status: 200 });
      }
      throw new Error("connection refused");
    }) as typeof fetch,
  });

  const aggregate = await client.registry.byHash(HASH);

  assert.equal(aggregate.schema_version, "1.0");
  assert.equal(aggregate.wasm_hash, HASH);
  // Nothing we emit declares x_extensions: the draft's closed schema rejects the declaration exactly as it
  // rejects the declared field.
  assert.equal("x_extensions" in aggregate, false);
  assert.equal(typeof aggregate.updated_at, "string");

  // The one verifier with a document contributes its entry, verbatim.
  assert.equal(aggregate.source_code_verifications.length, 1);
  assert.equal(aggregate.source_code_verifications[0].status, "verified");

  // 404 is absence, not unavailability: no entry AND no unavailable row.
  const unavailableRoots = aggregate.unavailable_verifiers.map((entry) => entry.url).sort();
  assert.deepEqual(
    unavailableRoots,
    ["https://10.1.2.3/", "https://garbage.test/", "https://unreachable.test/"].sort(),
  );
  const reasons = new Map(aggregate.unavailable_verifiers.map((entry) => [entry.url, entry.reason]));
  assert.equal(reasons.get("https://garbage.test/"), "invalid_response");
  assert.equal(reasons.get("https://unreachable.test/"), "fetch_failed");
  // A policy refusal is never reported as a timeout: no request was made, so latency would be a fabrication and
  // `refused` is the only reason that tells an operator what actually happened.
  assert.equal(reasons.get("https://10.1.2.3/"), "refused");
  for (const entry of aggregate.unavailable_verifiers) {
    assert.ok((entry.error ?? "").length > 0, `${entry.url} carries no reason`);
  }

  // A verifier the operator paused is neither queried nor reported as a failure.
  assert.equal(requested.some((url) => url.includes("paused.test")), false);
  assert.equal(unavailableRoots.includes("https://paused.test/"), false);

  // CI4: only the static per-hash key was read — no manifest, no index, no hosted API.
  assert.deepEqual(
    [...new Set(requested.map((url) => new URL(url).pathname))],
    [`/wasms/${HASH}.json`],
  );
}

/** `unavailable_verifiers` is always present, and an empty aggregate is a legitimate answer. */
async function alwaysPresentAndEmptyIsValid(): Promise<void> {
  const client = newClient({
    tvl: tvl(verifier("absent", "absent.test")),
    fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
  });
  const aggregate = await client.registry.byHash(HASH);
  assert.deepEqual(aggregate.unavailable_verifiers, []);
  assert.deepEqual(aggregate.source_code_verifications, []);
}

/** A peer answering for a different hash is refused, not merged. */
async function targetMismatchIsRefused(): Promise<void> {
  const other = { ...(await fixture(READABLE_DRAFT)), wasm_hash: "b".repeat(64) };
  const client = newClient({
    tvl: tvl(verifier("liar", "liar.test")),
    fetch: (async () => new Response(JSON.stringify(other), { status: 200 })) as typeof fetch,
  });
  const aggregate = await client.registry.byHash(HASH);
  assert.deepEqual(aggregate.source_code_verifications, []);
  assert.equal(aggregate.unavailable_verifiers[0]?.reason, "invalid_response");
  assert.match(aggregate.unavailable_verifiers[0]?.error ?? "", /does not match/i);
}

/** CV8: an unknown field on a peer's entry survives into the aggregate rather than being stripped. */
async function unknownFieldsSurvive(): Promise<void> {
  const document = await fixture(READABLE_DRAFT);
  (document.source_code_verifications as Record<string, unknown>[])[0].some_future_field = "kept";
  const client = newClient({
    tvl: tvl(verifier("forward", "forward.test")),
    fetch: (async () => new Response(JSON.stringify(document), { status: 200 })) as typeof fetch,
  });
  const aggregate = await client.registry.byHash(HASH);
  assert.equal(
    (aggregate.source_code_verifications[0] as unknown as Record<string, unknown>).some_future_field,
    "kept",
  );
}

/** SO7: a peer that adopts a higher MINOR stays readable. */
async function higherMinorIsReadable(): Promise<void> {
  const document: Record<string, unknown> = {
    ...(await fixture(READABLE_DRAFT)),
    schema_version: "1.1",
  };
  // A MINOR is additive, so a real 1.1 document carries fields 1.0 has no room for.
  (document.source_code_verifications as Record<string, unknown>[])[0].source_sha256 = "d".repeat(64);

  const client = newClient({
    tvl: tvl(verifier("modern", "modern.test")),
    fetch: (async () => new Response(JSON.stringify(document), { status: 200 })) as typeof fetch,
  });
  const aggregate = await client.registry.byHash(HASH);

  assert.deepEqual(aggregate.unavailable_verifiers, [], "a 1.1 peer must not be reported unavailable");
  assert.equal(aggregate.source_code_verifications.length, 1);
  assert.equal(aggregate.source_code_verifications[0].status, "verified");
  assert.equal(
    (aggregate.source_code_verifications[0] as unknown as Record<string, unknown>).source_sha256,
    "d".repeat(64),
  );
  // Our own aggregate still declares what WE conform to. A peer's MINOR is not contagious.
  assert.equal(aggregate.schema_version, "1.0");

  // The direct read is the same shape, and it reports the peer's version rather than assuming ours.
  const single = await client.registry.statusObject(
    { ...verifier("modern", "modern.test") } as never,
    HASH,
  );
  assert.equal(single.schema_version, "1.1");

  // Both validation modes: projecting to the base shape must not re-impose the producer's exactness.
  assert.equal(validateStatusObject(document, "peer-1.1").schema_version, "1.1");
  assert.equal(validateStatusObject(document, "peer-1.1", "strict-base").schema_version, "1.1");
}

/**
 * The other half of "branch on MAJOR". A 2.x document may have redefined a field we read, so accepting it would
 * let us restate a claim the peer never made — `invalid_response` is honest.
 */
async function unknownMajorIsRefused(): Promise<void> {
  const document = { ...(await fixture(READABLE_DRAFT)), schema_version: "2.0" };
  const client = newClient({
    tvl: tvl(verifier("future", "future.test")),
    fetch: (async () => new Response(JSON.stringify(document), { status: 200 })) as typeof fetch,
  });
  const aggregate = await client.registry.byHash(HASH);

  assert.deepEqual(aggregate.source_code_verifications, []);
  assert.equal(aggregate.unavailable_verifiers[0]?.reason, "invalid_response");
  assert.match(aggregate.unavailable_verifiers[0]?.error ?? "", /schema_version/);
}

/** One aggregation, in the Registry's vocabulary; artifact verification is the other surface. */
async function clientSurface(): Promise<void> {
  const client = newClient({ tvl: tvl(verifier("a", "a.test")) });
  assert.equal(typeof client.registry.byHash, "function");
  assert.equal(typeof client.registry.statusObject, "function");
  assert.equal(typeof client.results.verifyUrl, "function");
}

async function main(): Promise<void> {
  await draftExamplesParse();
  await validationModes();
  unknownStatusCoercion();
  keyConvention();
  await aggregationDegradesHonestly();
  await alwaysPresentAndEmptyIsValid();
  await targetMismatchIsRefused();
  await unknownFieldsSurvive();
  await higherMinorIsReadable();
  await unknownMajorIsRefused();
  await clientSurface();
  console.log(
    "SDK registry-read tests passed (draft examples, CV6/CV7/CV9 modes, unknown-status coercion, " +
      "wasms/<hash>.json key, honest degradation, CV8 forwarding, SO7 MAJOR branching)",
  );
}

await main();
