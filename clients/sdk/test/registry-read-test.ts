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

const here = dirname(fileURLToPath(import.meta.url));
const registryFixtures = resolve(here, "../../../test/fixtures/registry");

const ORIGIN = "https://verify.example.test";
const HASH = "cb2fc3a1b4d5e6f7081928374655647382910abcdef0123456789abcdef01234";

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(registryFixtures, name), "utf8")) as Record<string, unknown>;
}

const READABLE_DRAFT = "200-out-of-band.json";

const BARE_STRING_LINKS = "200-verified.json";

async function draftExamplesParse(): Promise<void> {
  const files = (await readdir(registryFixtures)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 5, `expected the draft's examples, found ${files.length}`);
  for (const name of files) {
    const document = await fixture(name);
    const parsed = validateStatusObject(document, name);
    assert.equal(parsed.schema_version, "1.0", `${name} lost its schema_version`);
    assert.ok(parsed.source_code_verifications.length >= 1, `${name} parsed with no verifications`);
  }

  const raw = (await fixture(BARE_STRING_LINKS)) as {
    source_code_verifications: { results_urls?: unknown[] }[];
  };
  const links = raw.source_code_verifications[0].results_urls ?? [];
  assert.ok(links.some((link) => typeof link === "string"), `${BARE_STRING_LINKS} lost its bare-string links`);
}

async function validationModes(): Promise<void> {
  const extended = {
    ...(await fixture(READABLE_DRAFT)),
    x_extensions: ["some-peer.extension/1.0"],
    source_sha256: "a".repeat(64),
  };

  const relaxed = validateStatusObject(extended, "extended");
  assert.equal(relaxed.wasm_hash, HASH);

  const strict = validateStatusObject(extended, "extended", "strict-base");
  assert.equal(strict.wasm_hash, HASH);
  assert.equal((strict as unknown as Record<string, unknown>).x_extensions, undefined);
  assert.equal((strict as unknown as Record<string, unknown>).source_sha256, undefined);
  assert.deepEqual(extended.x_extensions, ["some-peer.extension/1.0"]);

  const newStatus = { ...(await fixture(READABLE_DRAFT)) };
  (newStatus.source_code_verifications as Record<string, unknown>[])[0].status = "mismatch";
  assert.equal(displayStatusOf(validateStatusObject(newStatus, "new-status").source_code_verifications[0]), "unverified");
  assert.equal(displayStatusOf(validateStatusObject(newStatus, "new-status", "strict-base").source_code_verifications[0]), "unverified");

  const badShape = { ...(await fixture(READABLE_DRAFT)) };
  (badShape.source_code_verifications as Record<string, unknown>[])[0].verifier = "not an object";
  assert.throws(() => validateStatusObject(badShape, "bad-shape"), RegistryDocumentError);
  assert.throws(() => validateStatusObject(badShape, "bad-shape", "strict-base"), RegistryDocumentError);

  assert.throws(() => validateStatusObject("not an object", "junk"), RegistryDocumentError);
  assert.throws(() => validateStatusObject([], "array"), RegistryDocumentError);
}

function unknownStatusCoercion(): void {
  assert.equal(displayStatusOf({ status: "verified" } as RegistryVerification), "verified");
  assert.equal(displayStatusOf({ status: "mismatched" } as RegistryVerification), "mismatched");
  assert.equal(
    displayStatusOf({ status: "something-the-draft-added-later" } as unknown as RegistryVerification),
    "unverified",
  );
}

function keyConvention(): void {
  assert.equal(statusObjectUrl(`${ORIGIN}/`, HASH), `${ORIGIN}/wasms/${HASH}.json`);
  assert.equal(statusObjectUrl(ORIGIN, HASH.toUpperCase()), `${ORIGIN}/wasms/${HASH}.json`);

  assert.equal(statusObjectUrl(`${ORIGIN}/verifier-a`, HASH), `${ORIGIN}/verifier-a/wasms/${HASH}.json`);
  assert.equal(statusObjectUrl(`${ORIGIN}/verifier-a/`, HASH), `${ORIGIN}/verifier-a/wasms/${HASH}.json`);

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

async function aggregationDegradesHonestly(): Promise<void> {
  const good = await fixture(READABLE_DRAFT);
  const list = tvl(
    verifier("good", "good.test"),
    verifier("absent", "absent.test"),
    verifier("garbage", "garbage.test"),
    verifier("unreachable", "unreachable.test"),
    verifier("paused-by-operator", "paused.test", "paused"),
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
  assert.equal("x_extensions" in aggregate, false);
  assert.equal(typeof aggregate.updated_at, "string");

  assert.equal(aggregate.source_code_verifications.length, 1);
  assert.equal(aggregate.source_code_verifications[0].status, "verified");

  const unavailableRoots = aggregate.unavailable_verifiers.map((entry) => entry.url).sort();
  assert.deepEqual(
    unavailableRoots,
    ["https://10.1.2.3/", "https://garbage.test/", "https://unreachable.test/"].sort(),
  );
  const reasons = new Map(aggregate.unavailable_verifiers.map((entry) => [entry.url, entry.reason]));
  assert.equal(reasons.get("https://garbage.test/"), "invalid_response");
  assert.equal(reasons.get("https://unreachable.test/"), "fetch_failed");
  assert.equal(reasons.get("https://10.1.2.3/"), "refused");
  for (const entry of aggregate.unavailable_verifiers) {
    assert.ok((entry.error ?? "").length > 0, `${entry.url} carries no reason`);
  }

  assert.equal(requested.some((url) => url.includes("paused.test")), false);
  assert.equal(unavailableRoots.includes("https://paused.test/"), false);

  assert.deepEqual(
    [...new Set(requested.map((url) => new URL(url).pathname))],
    [`/wasms/${HASH}.json`],
  );
}

async function alwaysPresentAndEmptyIsValid(): Promise<void> {
  const client = newClient({
    tvl: tvl(verifier("absent", "absent.test")),
    fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
  });
  const aggregate = await client.registry.byHash(HASH);
  assert.deepEqual(aggregate.unavailable_verifiers, []);
  assert.deepEqual(aggregate.source_code_verifications, []);
}

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

async function higherMinorIsReadable(): Promise<void> {
  const document: Record<string, unknown> = {
    ...(await fixture(READABLE_DRAFT)),
    schema_version: "1.1",
  };
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
  assert.equal(aggregate.schema_version, "1.0");

  const single = await client.registry.statusObject(
    { ...verifier("modern", "modern.test") } as never,
    HASH,
  );
  assert.equal(single.schema_version, "1.1");

  assert.equal(validateStatusObject(document, "peer-1.1").schema_version, "1.1");
  assert.equal(validateStatusObject(document, "peer-1.1", "strict-base").schema_version, "1.1");
}

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
