import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  newClient,
  checkUrl,
  createGuardedFetch,
  normalizePolicy,
  originsFromVerifiers,
  readBoundedBytes,
  fetchAndVerifyResultUrl,
  FetchPolicyError,
  ResponseTooLargeError,
  HashMismatchError,
  UnverifiableEntryError,
  type TrustedVerifiersList,
  type TrustedVerifier,
  type VerifierDiscovery,
  manifestRootOf,
} from "../src/index.js";

// The `node:` imports are the test's, not the SDK's: reading the fixture tree is this file's job, through a
// `fetch` it supplies.

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "../../../test/fixtures/verifiers");
const trustedListUrl = pathToFileURL(join(fixtureRoot, "trusted-verifiers.local.json")).toString();
const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const wasmHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * Serves `file://` from disk, 404s a missing file. A real `Response`, not a hand-rolled object: the client
 * reads bodies through the size bound, so a `json()`-only double would test a different path.
 */
const fileFetch: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  try {
    return new Response(await readFile(fileURLToPath(url), "utf8"), { status: 200 });
  } catch {
    return new Response("{}", { status: 404 });
  }
}) as typeof fetch;

const loadTvl = async (): Promise<TrustedVerifiersList> =>
  JSON.parse(await readFile(fileURLToPath(trustedListUrl), "utf8")) as TrustedVerifiersList;

async function aggregation(): Promise<void> {
  const tvl = await loadTvl();
  // `file:` opted into explicitly; the default policy is https-only.
  const client = newClient({
    tvl,
    baseUrl: trustedListUrl,
    fetch: fileFetch,
    policy: { allowedSchemes: ["file:"], allowedOrigins: [] },
  });

  const aggregate = await client.registry.byHash(wasmHash);
  assert.equal(aggregate.schema, "stellar-verification-aggregate");
  assert.equal(aggregate.schema_version, "1.0");
  assert.equal(aggregate.wasm_hash, wasmHash);
  // CV11, and SDK2/SDK5's "identical output shape": the client-side fan-out relays each peer's own `verifier`
  // block untouched and stamps the version of the document it came from, which is not the envelope's.
  assert.ok(
    aggregate.source_code_verifications.every((entry) => entry.verifier.url !== undefined),
    "every relayed entry carries the result root it came from",
  );
  assert.ok(
    aggregate.source_code_verifications.every((entry) => entry.schema_version !== undefined),
    "every relayed entry carries the version of the document it came from",
  );
  assert.deepEqual(
    aggregate.source_code_verifications.map((entry) => entry.status),
    ["verified", "mismatched"],
  );
  assert.deepEqual(aggregate.unavailable_verifiers, []);
  // Two entries that disagree — reported, never adjudicated.
  assert.equal(aggregate.agreement, "disputed");

  // A hash nobody has published is an empty aggregate, not an error and not an unavailable verifier: the peers
  // answered, and the answer was "nothing here".
  const missing = await client.registry.byHash("c".repeat(64));
  assert.deepEqual(missing.source_code_verifications, []);
  assert.deepEqual(missing.unavailable_verifiers, []);
  assert.equal(missing.agreement, "no_data");

  // A peer serving something unparseable is named, never silently dropped.
  const invalid = newClient({
    tvl,
    baseUrl: trustedListUrl,
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("verifier-b")) return new Response("{\"schema_version\":\"9.9\"}", { status: 200 });
      return fileFetch(input);
    }) as typeof fetch,
    policy: { allowedSchemes: ["file:"], allowedOrigins: [] },
  });
  const degraded = await invalid.registry.byHash(wasmHash);
  assert.equal(degraded.source_code_verifications.length, 1);
  assert.deepEqual(
    degraded.unavailable_verifiers.map((entry) => [entry.url, entry.reason]),
    // The RESOLVED root: a relative `url` is made absolute against `baseUrl` before it can identify anything,
    // and identifying is what this field now does.
    [[invalid.verifiers[1]!.url, "invalid_response"]],
  );
  // One entry is `single`, never `unanimous_verified` — one verifier is not a consensus.
  assert.equal(degraded.agreement, "single");
}

/** SDK-07: the SDK follows each TVL entry through its manifest and published policy. */
async function discovery(): Promise<void> {
  const tvl = await loadTvl();
  const requested: string[] = [];
  const client = newClient({
    tvl,
    baseUrl: trustedListUrl,
    fetch: (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return fileFetch(input);
    }) as typeof fetch,
    policy: { allowedSchemes: ["file:"], allowedOrigins: [] },
  });

  const discovered = await client.discover();
  assert.deepEqual(
    discovered.map((entry) => [
      entry.verifier.id,
      entry.outcome,
      entry.outcome === "available" ? entry.manifest.id : undefined,
      entry.outcome === "available" ? entry.policy.id : undefined,
    ]),
    [
      ["fixture-verifier-a", "available", "fixture-verifier-a", "fixture-policy-a"],
      ["fixture-verifier-b", "available", "fixture-verifier-b", "fixture-policy-b"],
    ],
  );
  for (const verifier of tvl.verifiers) {
    assert.ok(
      requested.some((url) => url.endsWith(`${verifier.id.replace("fixture-", "")}/verifier-manifest.json`)),
      `manifest was not requested for ${verifier.id}`,
    );
  }
  assert.equal(requested.filter((url) => url.endsWith("/policy.json")).length, 2);

  // A peer whose rollout lags still spells its root `cdn_root` (renamed 2026-09-03, and a
  // manifest moves only when the verifier publishing it is redeployed). `discover()` fans out, so
  // rejecting one such manifest must not fail every other verifier with it.
  const lagging: typeof fetch = (async (input: RequestInfo | URL) => {
    const response = await fileFetch(input);
    if (!String(input).endsWith("verifier-a/verifier-manifest.json")) return response;
    const { url: root, ...rest } = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...rest, cdn_root: root }), { status: 200 });
  }) as typeof fetch;

  const withLegacyRoot = await discoverWith(tvl, lagging);
  assert.equal(withLegacyRoot.length, 2, "a pre-rename manifest must not remove its peer");
  const legacy = pick(withLegacyRoot, "fixture-verifier-a");
  assert.ok(legacy.outcome === "available");
  // `url` is typed optional on the peer manifest because the validator lets it go missing — this assertion
  // is the proof, and it used to contradict a type that promised a `string`.
  assert.equal(legacy.manifest.url, undefined);
  assert.equal(legacy.manifest.cdn_root, ".");
  assert.equal(manifestRootOf(legacy.manifest), ".", "either spelling reads through one accessor");

  // ── the three outcomes ────────────────────────────────────────────────────────────
  // `manifest_url` is OPTIONAL in the Results SEP, and nothing this client needs is read out of a manifest.
  // So a member that advertises none, a member whose manifest cannot be fetched, and a member that serves
  // something unparseable are three different answers — and each is an answer about that member alone.

  // (1) Advertises nothing. Not a failure: the entry keeps its place and its result root.
  const silent = structuredClone(tvl) as unknown as { verifiers: Record<string, unknown>[] };
  delete silent.verifiers[0].manifest_url;
  const withSilent = await discoverWith(silent as unknown as TrustedVerifiersList, fileFetch);
  assert.equal(withSilent.length, 2);
  const notAdvertised = pick(withSilent, "fixture-verifier-a");
  assert.equal(notAdvertised.outcome, "not_advertised");
  assert.ok(notAdvertised.verifier.url.endsWith("verifier-a"), "the result root survives resolution");
  assert.equal(notAdvertised.verifier.manifest_url, undefined, "resolution invents no reference");
  assert.equal(pick(withSilent, "fixture-verifier-b").outcome, "available");

  // (2) Advertised and unreachable. The peer's failure is reported as that peer's, and its neighbour still
  // resolves — the fan-out isolation `Promise.all` did not have.
  const unreachable = await discoverWith(
    tvl,
    intercept("verifier-a/verifier-manifest.json", () => new Response("nope", { status: 500 })),
  );
  assert.equal(unreachable.length, 2, "one dead manifest host must not empty the fan-out");
  const failed = pick(unreachable, "fixture-verifier-a");
  assert.ok(failed.outcome === "unavailable");
  assert.equal(failed.reason, "fetch_failed");
  assert.match(failed.error ?? "", /500/);
  assert.equal(pick(unreachable, "fixture-verifier-b").outcome, "available");

  // (3) Advertised, reachable, and not a manifest. Distinguished from (2), because a peer serving its login
  // page at that URL is a different operational problem than a peer being down.
  const garbage = await discoverWith(
    tvl,
    intercept(
      "verifier-a/verifier-manifest.json",
      () => new Response(JSON.stringify({ schema: "not-a-manifest" }), { status: 200 }),
    ),
  );
  const invalid = pick(garbage, "fixture-verifier-a");
  assert.ok(invalid.outcome === "unavailable");
  assert.equal(invalid.reason, "invalid_response");
  assert.equal(pick(garbage, "fixture-verifier-b").outcome, "available");

  // (3b) Advertised, reachable, 200 — and HTML. `JSON.parse` throws before any DTO sees it, so this is the
  // path that used to come back `fetch_failed`: an operator would have gone looking at the network for a
  // peer that is answering perfectly well with the wrong document.
  const htmlPage = await discoverWith(
    tvl,
    intercept(
      "verifier-a/verifier-manifest.json",
      () => new Response("<!doctype html><title>503 Backend unavailable</title>", { status: 200 }),
    ),
  );
  const notJson = pick(htmlPage, "fixture-verifier-a");
  assert.ok(notJson.outcome === "unavailable");
  assert.equal(notJson.reason, "invalid_response");
  assert.equal(pick(htmlPage, "fixture-verifier-b").outcome, "available");

  // A manifest whose `policy_url` cannot be read collapses to `unavailable` rather than to a half-populated
  // `available`: `policy` is present on that arm only, so there is no state where it is missing.
  const policyless = await discoverWith(
    tvl,
    intercept("verifier-a/policy.json", () => new Response("gone", { status: 404 })),
  );
  const noPolicy = pick(policyless, "fixture-verifier-a");
  assert.ok(noPolicy.outcome === "unavailable");
  assert.match(noPolicy.error ?? "", /policy\.json/);
  assert.equal(pick(policyless, "fixture-verifier-b").outcome, "available");
}

/** One `discover()` against the fixture tree, through a caller-supplied `fetch`. */
async function discoverWith(
  tvl: TrustedVerifiersList,
  fetchImpl: typeof fetch,
): Promise<readonly VerifierDiscovery[]> {
  return newClient({
    tvl,
    baseUrl: trustedListUrl,
    fetch: fetchImpl,
    policy: { allowedSchemes: ["file:"], allowedOrigins: [] },
  }).discover();
}

/** The fixture tree, with one URL suffix answered by `response` instead. */
function intercept(suffix: string, response: () => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input).endsWith(suffix)) return response();
    return fileFetch(input);
  }) as typeof fetch;
}

/** `discover()` answers per member, in the list's order, so every member is findable by id. */
function pick(discovered: readonly VerifierDiscovery[], id: string): VerifierDiscovery {
  const found = discovered.find(({ verifier }) => verifier.id === id);
  assert.ok(found, `${id} is missing from discover()`);
  return found;
}

/**
 * Over real HTTP, and through a relative `url`: the resolution the fixture tree's `file:` URLs cannot exercise,
 * against a server that answers real 404s.
 */
async function relativeRootOverHttp(): Promise<void> {
  const statusPath = `/verifier-x/wasms/${wasmHash}.json`;
  const document = {
    schema_version: "1.0",
    wasm_hash: wasmHash,
    updated_at: "2026-06-30T00:00:00.000Z",
    source_code_verifications: [
      {
        verifier: { name: "HTTP Verifier", url: "https://x.example" },
        status: "verified",
        processed_at: "2026-06-30T00:00:00.000Z",
        out_of_band: false,
        bldimg: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
        bldopt: [],
        source_repo: "https://github.com/example/x",
        source_rev: "0".repeat(39) + "1",
        verified_source_code_uri: "https://x.example/source/x.tar.gz",
        results_urls: [{ type: "report", url: "https://x.example/reports/x.json", sha256: "c".repeat(64) }],
      },
    ],
  };

  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    if ((request.url ?? "") !== statusPath) {
      response.writeHead(404).end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(document));
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = newClient({
      // `url` is relative; `baseUrl` is what makes it absolute.
      tvl: {
        schema: "stellar-trusted-verifiers-list-v1",
        verifiers: [
          {
            id: "http-verifier",
            display_name: "HTTP Verifier",
            url: "verifier-x/",
            manifest_url: "verifier-x/verifier-manifest.json",
            bulk_load_url: "verifier-x/api/verification/v1/wasms",
            trust_tier: "primary",
            status: "active",
          },
        ],
        updated_at: "2026-06-30T00:00:00.000Z",
      },
      baseUrl: `${origin}/`,
      timeoutMs: 5_000,
      // A loopback test root: both opt-outs named explicitly rather than left to a default.
      policy: { allowedSchemes: ["http:"], blockPrivateRanges: false },
    });

    const aggregate = await client.registry.byHash(wasmHash);
    assert.deepEqual(
      aggregate.source_code_verifications.map((entry) => entry.status),
      ["verified"],
      `relative url did not resolve; requested ${JSON.stringify(requested)}`,
    );
    assert.equal(aggregate.agreement, "single");
    assert.deepEqual(requested, [statusPath]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

async function tvlValidation(): Promise<void> {
  // Existing behaviour to keep: the list was validated when it was loaded from a URL, and moving it to a
  // parameter must not turn a validated input into a trusted one.
  assert.throws(() => newClient({ tvl: {} as never }), /schema|verifiers/i);

  const tvl = await loadTvl();
  // `manifest_url` is OPTIONAL: the document behind it is not defined by the Results SEP and this client reads
  // no field out of it, so an entry without one is a conformance class and must load. It surfaces as
  // `discover()`'s `not_advertised`, not as a rejected list.
  const silent = structuredClone(tvl) as unknown as { verifiers: Record<string, unknown>[] };
  delete silent.verifiers[0].manifest_url;
  assert.doesNotThrow(() => newClient({ tvl: silent as never }), "an entry may advertise no manifest");

  // The result root is the one reference an entry cannot omit, because it is the entry's identity.
  const rootless = structuredClone(tvl) as unknown as { verifiers: Record<string, unknown>[] };
  delete rootless.verifiers[0].url;
  assert.throws(() => newClient({ tvl: rootless as never }), /result root|cdn_root/i);

  // ── the minimum a conformant entry may carry ──────────────────────────────────────
  // `verifier_entry.required` in the published schema is `["url", "status"]` and nothing else: `id`,
  // `display_name`, `manifest_url` and `bulk_load_url` are all optional. A consumer that demanded any of
  // them would reject a list the SEP permits, so this is the whole of a legal entry.
  const minimal = {
    schema: "stellar-trusted-verifiers-list",
    schema_version: "1.0",
    updated_at: "2026-09-09T00:00:00.000Z",
    verifiers: [{ url: "verifier-a", status: "active" }],
  };
  assert.doesNotThrow(
    () => newClient({ tvl: minimal as never, baseUrl: trustedListUrl }),
    "an entry of just url + status is conformant",
  );
  const minimalClient = newClient({
    tvl: minimal as never,
    baseUrl: trustedListUrl,
    fetch: fileFetch,
    policy: { allowedSchemes: ["file:"], allowedOrigins: [] },
  });
  assert.equal(minimalClient.verifiers[0].id, undefined);
  assert.equal(minimalClient.verifiers[0].display_name, undefined);
  const [only] = await minimalClient.discover();
  assert.equal(only?.outcome, "not_advertised", "no manifest_url reaches not_advertised, not a throw");
  // And it still answers the question the SEP is actually about: the result root is all that takes.
  const answer = await minimalClient.registry.byHash(wasmHash);
  assert.ok(answer.source_code_verifications.length > 0, "a nameless entry is still queryable");
  assert.deepEqual(answer.unavailable_verifiers, []);

  // ── the document rename is ours, the caller's list is theirs ───────────────────────
  // Every fixture in this file still spells `stellar-trusted-verifiers-list-v1`, which is the point: renaming
  // the document for the Results SEP must not stop this client reading a list somebody wrote before it.
  const renamed = structuredClone(tvl) as unknown as Record<string, unknown>;
  renamed.schema = "stellar-trusted-verifiers-list";
  renamed.schema_version = "1.0";
  assert.doesNotThrow(() => newClient({ tvl: renamed as never }), "the SEP spelling parses");

  const higherMinor = { ...renamed, schema_version: "1.4" };
  assert.doesNotThrow(() => newClient({ tvl: higherMinor as never }), "a higher MINOR is readable (SO7)");
  assert.throws(() => newClient({ tvl: { ...renamed, schema_version: "2.0" } as never }), /schema_version/i);
  assert.throws(() => newClient({ tvl: { ...renamed, schema: "something-else" } as never }), /schema/i);
}

/** `checkUrl` runs before a request goes out, so a refusal here means nothing was sent. */
async function fetchPolicy(): Promise<void> {
  const tvlOrigins = ["https://verify.example.com"];
  const strict = normalizePolicy({ allowedOrigins: tvlOrigins });

  // The scheme allowlist. `file:` is what the deleted local-path branch reached through (the arbitrary-read
  // sink), so it is refused before a request rather than merely unimplemented.
  assert.throws(() => checkUrl(strict, "file:///etc/passwd"), FetchPolicyError);
  assert.throws(() => checkUrl(strict, "http://verify.example.com/wasms/x.json"), FetchPolicyError);
  assert.doesNotThrow(() => checkUrl(strict, "https://verify.example.com/wasms/x.json"));

  // Off-allowlist origins: a manifest template may only reach origins the TVL named.
  assert.throws(() => checkUrl(strict, "https://evil.example.com/x.json"), FetchPolicyError);

  // Private / loopback / link-local IP literals — the cloud metadata endpoint above all.
  for (const host of ["169.254.169.254", "10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "[::1]", "[fd00::1]"]) {
    const permissive = normalizePolicy({ allowedOrigins: [`https://${host}`] });
    assert.throws(() => checkUrl(permissive, `https://${host}/latest/meta-data/`), FetchPolicyError,
      `${host} should be refused as a private-range literal`);
  }
  // Both spellings: WHATWG URL normalizes `::ffff:169.254.169.254` to hex, so a dotted-only check never fires
  // and the metadata endpoint stayed reachable through the other address family.
  for (const host of ["[::ffff:169.254.169.254]", "[::ffff:a9fe:a9fe]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]", "[0:0:0:0:0:0:0:1]"]) {
    const permissive = normalizePolicy({ allowedOrigins: [] });
    assert.throws(() => checkUrl(permissive, `https://${host}/latest/meta-data/`), FetchPolicyError,
      `${host} should be refused as an IPv4-mapped or expanded private literal`);
  }
  // A mapped PUBLIC address is still allowed — the fix must not block the whole ::ffff: space.
  assert.doesNotThrow(() =>
    checkUrl(normalizePolicy({ allowedOrigins: [] }), "https://[::ffff:8.8.8.8]/x.json"),
  );

  // ...and reachable only by naming the opt-out, which is what a local dev root does.
  assert.doesNotThrow(() =>
    checkUrl(normalizePolicy({ allowedOrigins: [], blockPrivateRanges: false }), "https://127.0.0.1/x.json"),
  );

  // An opaque origin serializes to "null" for every such URL, so an allowlist holding one would admit every
  // other.
  assert.throws(
    () => checkUrl(normalizePolicy({ allowedSchemes: ["file:"], allowedOrigins: ["null"] }), "file:///etc/passwd"),
    FetchPolicyError,
  );

  // Loopback by name, and the whole of fe80::/10 rather than the fe80: prefix alone.
  for (const blocked of ["https://localhost/x.json", "https://app.localhost/x.json", "https://[feb0::1]/x.json"]) {
    assert.throws(() => checkUrl(strict, blocked), FetchPolicyError, `expected ${blocked} to be refused`);
  }

  // It is a rejection now.
  assert.throws(() => normalizePolicy({ timeoutMs: 0 }), FetchPolicyError);
  assert.throws(() => normalizePolicy({ timeoutMs: -1 }), FetchPolicyError);

  // The origin allowlist a client derives from its own TVL. The third entry advertises no manifest, which
  // contributes no origin rather than removing the entry from the allowlist.
  assert.deepEqual(
    originsFromVerifiers([
      { url: "https://a.example/results/", manifest_url: "https://a.example/verifier-manifest.json" },
      { url: "https://b.example/", manifest_url: "https://cdn.b.example/m.json" },
      { url: "https://c.example/results/" },
    ]),
    ["https://a.example", "https://b.example", "https://cdn.b.example", "https://c.example"],
  );

  // The post-redirect re-check: `fetch` follows redirects internally, so an allowed origin handing the client
  // off to a blocked one is caught on the way back or not at all.
  const redirecting = createGuardedFetch(strict, (async () =>
    ({ ok: true, status: 200, url: "https://evil.example.com/x.json", json: async () => ({}) }) as Response) as typeof fetch);
  await assert.rejects(() => redirecting("https://verify.example.com/x.json"), FetchPolicyError);

  // The size bound, with a lying Content-Length: the running count is the control.
  const oversized = new Response(new Blob([new Uint8Array(64) as BlobPart]), {
    headers: { "content-length": "1" },
  });
  await assert.rejects(() => readBoundedBytes(oversized, 16), ResponseTooLargeError);
}

/** Content is checked against the declared `sha256`, and treated as untrusted bytes either way. */
async function resultUrlVerification(): Promise<void> {
  const body = new TextEncoder().encode('{"schema_version":"1.0"}');
  const digest = await sha256Hex(body);
  const url = "https://verify.example.com/reports/abc.json";
  const serve = (bytes: Uint8Array): typeof fetch =>
    (async () => new Response(new Blob([bytes as BlobPart]), { status: 200 })) as typeof fetch;
  const policy = { allowedOrigins: ["https://verify.example.com"] };

  const verified = await fetchAndVerifyResultUrl(
    { type: "report", url, sha256: digest },
    { fetch: serve(body), policy },
  );
  assert.equal(verified.verified, true);
  assert.equal(verified.type, "report");
  assert.equal(verified.origin, "https://verify.example.com"); // what an interstitial shows
  assert.deepEqual(new Uint8Array(verified.bytes), body);

  // Tampered bytes: no bytes come back at all, in any shape.
  await assert.rejects(
    () => fetchAndVerifyResultUrl({ type: "report", url, sha256: digest },
      { fetch: serve(new TextEncoder().encode("tampered")), policy }),
    HashMismatchError,
  );

  // No `sha256` — refused by default, because a function named "verify" must not return unchecked bytes.
  await assert.rejects(
    () => fetchAndVerifyResultUrl({ type: "report", url }, { fetch: serve(body), policy }),
    UnverifiableEntryError,
  );
  // ...and under the opt-in it is structurally distinct from a verified result.
  const unverified = await fetchAndVerifyResultUrl(
    { type: "report", url },
    { fetch: serve(body), policy, allowUnverified: true },
  );
  assert.equal(unverified.verified, false);
  assert.equal(unverified.sha256, undefined);

  // The policy applies here first: a `results_urls` entry pointing at the metadata endpoint is refused before a
  // request is made.
  await assert.rejects(
    () => fetchAndVerifyResultUrl(
      { type: "report", url: "https://169.254.169.254/latest/meta-data/", sha256: digest },
      { fetch: serve(body) },
    ),
    FetchPolicyError,
  );

  // The injectable hasher (an insecure browser context has no `crypto.subtle`).
  const injected = await fetchAndVerifyResultUrl(
    { type: "report", url, sha256: "ff".repeat(32) },
    { fetch: serve(body), policy, hasher: async () => "ff".repeat(32) },
  );
  assert.equal(injected.verified, true);
}

/** Aggregation never fetches a `results_urls` entry on its own. */
async function aggregationDoesNotFollowResultUrls(): Promise<void> {
  const tvl = await loadTvl();
  const requested: string[] = [];
  const client = newClient({
    tvl,
    baseUrl: trustedListUrl,
    fetch: (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return fileFetch(input);
    }) as typeof fetch,
    // `allowedOrigins: []` opted into as well: a `file:` URL has no identifiable origin, so origin pinning is
    // not available here and has to be waived by name.
    policy: { allowedSchemes: ["file:"], allowedOrigins: [] },
  });
  await client.registry.byHash(wasmHash);
  // The fixture documents carry `results_urls`; aggregation may report them but must not follow them.
  assert.equal(
    requested.some((url) => url.includes("/reports/")),
    false,
    `aggregation fetched an artifact: ${JSON.stringify(requested)}`,
  );
}

/**
 * A peer's own bulk load is the only way to learn which hashes it has: its root holds one document per hash and
 * HTTPS offers no way to list them.
 */
async function peerEnumeration(): Promise<void> {
  // Deliberately WITHOUT `schema`: this is a peer that has not cut over to the SEP page shape, and the consumer
  // class must read it anyway (CV6).
  const page = {
    schema_version: "1.0",
    order: "asc",
    cursor: "1780000000000-" + "e".repeat(64),
    records: [
      { wasm_hash: "e".repeat(64), updated_at: "2026-06-30T00:00:00.000Z" },
      { wasm_hash: "f".repeat(64), updated_at: "2026-06-30T00:00:01.000Z" },
    ],
  };

  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(page));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    // A different host than the static root, which is the normal arrangement — a CDN serves one and an
    // application the other — so the policy has to trust this origin too.
    const bulkOrigin = `http://127.0.0.1:${address.port}`;
    const verifier = {
      id: "peer",
      display_name: "Peer",
      url: "https://cdn.peer.example/",
      manifest_url: "https://cdn.peer.example/verifier-manifest.json",
      bulk_load_url: `${bulkOrigin}/api/verification/v1/wasms`,
      trust_tier: "community" as const,
      status: "active" as const,
    };
    const client = newClient({
      tvl: { schema: "stellar-trusted-verifiers-list-v1", verifiers: [verifier], updated_at: "2026-06-30T00:00:00.000Z" },
      policy: { allowedSchemes: ["https:", "http:"], blockPrivateRanges: false },
    });

    const walked = await client.registry.bulkLoad(verifier, { limit: 2 });
    assert.deepEqual(walked.records.map((record) => record.wasm_hash), ["e".repeat(64), "f".repeat(64)]);
    assert.equal(walked.cursor, page.cursor);
    // Resumed, not restarted: the cursor is what stops a re-walk re-reading everything they have.
    await client.registry.bulkLoad(verifier, { cursor: walked.cursor as string, limit: 2 });
    assert.ok(requested[1].includes(`cursor=${encodeURIComponent(page.cursor)}`), requested[1]);

    // `bulk_load_url` is required on `TrustedVerifier`.
    const noBulkLoadUrl = { ...verifier, bulk_load_url: undefined } as unknown as TrustedVerifier;
    await assert.rejects(() => client.registry.bulkLoad(noBulkLoadUrl), /names no bulk_load_url/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

async function hostileInputs(): Promise<void> {
  const tvl = await loadTvl();

  // A redirect is refused rather than followed: `fetch` cannot expose the hops in between, so the guard would
  // only ever see the last one.
  let seen: RequestInit | undefined;
  const recording = createGuardedFetch(normalizePolicy({ allowedOrigins: [] }), (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    seen = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch);
  await recording("https://verify.example.com/x.json");
  assert.equal(seen?.redirect, "error");

  // ...and following is available by name, with the last hop still checked.
  const following = createGuardedFetch(
    normalizePolicy({ allowedOrigins: [], followRedirects: true }),
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  );
  await following("https://verify.example.com/x.json");
  assert.equal(seen?.redirect, "follow");

  // A JSON array validates against any class — class-validator finds no metadata on it and reports no errors —
  // so the shape check cannot be left to the DTO alone.
  assert.throws(() => newClient({ tvl: [] as unknown as TrustedVerifiersList }), /not a JSON object/);

  // One unusable entry is that verifier's own failure, not the whole aggregation's.
  const withRelative: TrustedVerifiersList = {
    ...tvl,
    verifiers: [{ ...tvl.verifiers[0], id: "relative-root", url: "/results/", manifest_url: "/m.json" }],
  };
  const degraded = newClient({ tvl: withRelative, fetch: fileFetch, policy: { allowedSchemes: ["file:"], allowedOrigins: [] } });
  const results = await degraded.registry.byHash(wasmHash);
  assert.deepEqual(results.unavailable_verifiers.map((entry) => entry.url), [withRelative.verifiers[0]!.url]);

  await assert.rejects(
    () => fetchAndVerifyResultUrl(
      JSON.parse('{"type":"report","url":"https://verify.example.com/r.json","sha256":null}'),
      { fetch: fileFetch },
    ),
    UnverifiableEntryError,
  );

  // The client's own origins reach a peer-supplied artifact URL through this method, and only this method — the
  // free function pins nothing unless a caller passes a policy itself.
  const client = newClient({ tvl, baseUrl: trustedListUrl, fetch: fileFetch, policy: { allowedSchemes: ["file:"] } });
  await assert.rejects(
    () => client.results.verifyUrl({ type: "report", url: "https://attacker.example/collect", sha256: "00" }),
    FetchPolicyError,
  );

  // ...and the same holds for a client built with only `fetchFactory` (query-svc's DNS-pinned transport), not
  // just one built with `fetch`.
  let factoryCalls = 0;
  const factoryClient = newClient({
    tvl,
    baseUrl: trustedListUrl,
    fetchFactory: () => {
      factoryCalls += 1;
      return fileFetch;
    },
    // `allowedOrigins: []`: a `file:` URL has no identifiable origin, so origin pinning is opted out here too.
    policy: { allowedSchemes: ["file:"], allowedOrigins: [] },
  });
  await factoryClient.results.verifyUrl(
    { type: "report", url: trustedListUrl },
    { allowUnverified: true },
  );
  assert.equal(factoryCalls, 1, "verifyUrl must have used the client's fetchFactory, not a fallback global fetch");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<void> {
  await aggregation();
  await discovery();
  await relativeRootOverHttp();
  await tvlValidation();
  await fetchPolicy();
  await resultUrlVerification();
  await aggregationDoesNotFollowResultUrls();
  await peerEnumeration();
  await hostileInputs();
  console.log(
      "SDK client tests passed (aggregation, manifest/policy discovery, relative root over HTTP, TVL validation, " +
      "fetch policy, results_urls verification, no implicit artifact fetch, peer enumeration, "  +
      "hostile inputs)",
  );
}

await main();
