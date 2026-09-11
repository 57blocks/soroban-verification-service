import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  newClient,
  newHostedClient,
  queryApiFailureOf,
  QueryApiError,
  QUERY_API_V1,
  type AggregateReader,
  type SoveClient,
} from "../src/index.js";

// The hosted half of TRD §8.3, over real HTTP: a hand-rolled `fetch` double would skip the bound, the
// timeout and the redirect refusal, which is most of what this client is.

const WASM_HASH = "a".repeat(64);
const CONTRACT_ID = `C${"A".repeat(55)}`;

/** What query-svc answers — the producer shape, `schema` and all. */
const aggregate = (over: Record<string, unknown> = {}) => ({
  schema: "stellar-verification-aggregate",
  schema_version: "1.0",
  wasm_hash: WASM_HASH,
  updated_at: "2026-09-07T00:00:00.000Z",
  source_code_verifications: [
    {
      verifier: { url: "https://peer.example/public", name: "Peer One" },
      status: "verified",
      processed_at: "2026-09-07T00:00:00.000Z",
    },
  ],
  unavailable_verifiers: [],
  agreement: "single",
  ...over,
});

const TVL = {
  schema: "stellar-trusted-verifiers-list",
  schema_version: "1.0",
  verifiers: [
    {
      id: "peer-1",
      display_name: "Peer One",
      url: "https://peer.example/public",
      manifest_url: "https://peer.example/public/verifier-manifest.json",
      bulk_load_url: "https://peer.example/api/verification/v1/wasms",
      status: "active",
    },
  ],
  updated_at: "2026-09-07T00:00:00.000Z",
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** One server per case, and the paths it was actually asked for. */
async function withServer<T>(
  handler: Handler,
  body: (origin: string, requested: string[]) => Promise<T>,
): Promise<T> {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    handler(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return await body(`http://127.0.0.1:${address.port}`, requested);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const json = (response: ServerResponse, status: number, value: unknown) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

/** The failure a call produced, or a thrown assertion if it answered instead. */
async function failureOf(call: () => Promise<unknown>): Promise<ReturnType<typeof queryApiFailureOf>> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof QueryApiError, `expected a QueryApiError, got ${String(error)}`);
    return queryApiFailureOf(error);
  }
  throw new assert.AssertionError({ message: "the call answered where a failure was expected" });
}

/** The three routes, and the paths they are built from. */
async function routes(): Promise<void> {
  await withServer(
    (request, response) => {
      if ((request.url ?? "").endsWith("/verifiers")) return json(response, 200, TVL);
      json(response, 200, aggregate());
    },
    async (origin, requested) => {
      const client = newHostedClient({ baseUrl: origin });
      assert.equal(client.baseUrl, origin);

      const byHash = await client.registry.byHash(WASM_HASH);
      assert.equal(byHash.wasm_hash, WASM_HASH);
      assert.deepEqual(
        byHash.source_code_verifications.map((entry) => entry.status),
        ["verified"],
      );
      assert.equal(byHash.agreement, "single");

      await client.registry.byContract("testnet", CONTRACT_ID);

      const list = await client.verifiers();
      assert.deepEqual(
        list.verifiers.map((verifier) => verifier.id),
        ["peer-1"],
      );

      assert.deepEqual(requested, [
        `${QUERY_API_V1}/wasms/${WASM_HASH}`,
        // No network in the hash path (ADR-007), and one in the contract path.
        `${QUERY_API_V1}/contracts/testnet/${CONTRACT_ID}`,
        `${QUERY_API_V1}/verifiers`,
      ]);
    },
  );
}

/** The list a hosted read answers is the object the client-side mode takes. */
async function hostedListSeedsClientSideMode(): Promise<void> {
  await withServer(
    (_request, response) => json(response, 200, TVL),
    async (origin) => {
      const tvl = await newHostedClient({ baseUrl: origin }).verifiers();
      const client = newClient({ tvl });
      assert.deepEqual(
        client.verifiers.map((verifier) => verifier.url),
        ["https://peer.example/public"],
      );
    },
  );
}

/** A subject is not allowed to carry `../` out of the prefix it was joined onto. */
async function pathTraversal(): Promise<void> {
  await withServer(
    (_request, response) => json(response, 404, { error: "not_found", message: "no" }),
    async (origin, requested) => {
      const client = newHostedClient({ baseUrl: origin });
      await failureOf(() => client.registry.byHash("../../verifiers"));
      await failureOf(() => client.registry.byContract("testnet", "../../../etc/passwd"));

      for (const path of requested) {
        assert.ok(
          path.startsWith(`${QUERY_API_V1}/`),
          `${path} left the route prefix — a subject escaped its segment`,
        );
      }
    },
  );
}

/** query-svc's declared codes reach the caller; a body without one is synthesised from the status. */
async function declaredFailures(): Promise<void> {
  await withServer(
    (request, response) => {
      if ((request.url ?? "").includes("/contracts/")) {
        return json(response, 404, {
          schema: "stellar-verification-error",
          schema_version: "1.0",
          error: "contract_not_found",
          message: "No Wasm-executable contract at that address",
          status_code: 404,
        });
      }
      response.writeHead(503, { "content-type": "application/json" }).end("{}");
    },
    async (origin) => {
      const client = newHostedClient({ baseUrl: origin });

      const notFound = await failureOf(() => client.registry.byContract("mainnet", CONTRACT_ID));
      assert.equal(notFound.status, 404);
      assert.equal(notFound.code, "contract_not_found");
      assert.match(notFound.message, /No Wasm-executable contract/);

      // No `error` in the body, so the status is all there is to name it by.
      const undeclared = await failureOf(() => client.registry.byHash(WASM_HASH));
      assert.equal(undeclared.code, "http_503");
      assert.notEqual(undeclared.message, "");
    },
  );
}

/**
 * The two ways a 200 is not an answer: a console sharing the API's origin serving the SPA, and a
 * well-formed JSON document that is not this response.
 */
async function twoHundredIsNotAnAnswer(): Promise<void> {
  await withServer(
    (request, response) => {
      if ((request.url ?? "").includes("/verifiers")) {
        return response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>console");
      }
      json(response, 200, { hello: "world" });
    },
    async (origin) => {
      const client = newHostedClient({ baseUrl: origin });

      const spa = await failureOf(() => client.verifiers());
      assert.equal(spa.status, 200);
      assert.equal(spa.code, "invalid_response");
      assert.match(spa.message, /not JSON/);

      const wrongShape = await failureOf(() => client.registry.byHash(WASM_HASH));
      assert.equal(wrongShape.code, "invalid_response");
      assert.match(wrongShape.message, /wasm_hash/);
    },
  );
}

/** A consumer tolerates a higher MINOR of the MAJOR it reads, and refuses a MAJOR it does not (SO7/CV6). */
async function schemaVersionTolerance(): Promise<void> {
  await withServer(
    (request, response) =>
      json(
        response,
        200,
        aggregate(
          (request.url ?? "").includes("/contracts/")
            ? { schema_version: "2.0" }
            : { schema_version: "1.7", agreement: "a_summary_added_after_us" },
        ),
      ),
    async (origin) => {
      const client = newHostedClient({ baseUrl: origin });

      // The unknown summary rides along: an aggregate is not rejected for a field a reader renders as text.
      const tolerated = await client.registry.byHash(WASM_HASH);
      assert.equal(tolerated.agreement as string, "a_summary_added_after_us");

      const refused = await failureOf(() => client.registry.byContract("testnet", CONTRACT_ID));
      assert.equal(refused.code, "invalid_response");
      assert.match(refused.message, /schema_version/);
    },
  );
}

/** No response, a slow one, and one too large to read: three failures with three codes. */
async function transportFailures(): Promise<void> {
  // A port nothing listens on. Bound and released first, so the number is one nothing else took.
  const dead = await withServer(
    () => undefined,
    async (origin) => origin,
  );
  const unreachable = await failureOf(() => newHostedClient({ baseUrl: dead }).registry.byHash(WASM_HASH));
  assert.equal(unreachable.status, 0);
  assert.equal(unreachable.code, "unreachable");

  await withServer(
    (_request, response) => {
      setTimeout(() => json(response, 200, aggregate()), 400).unref();
    },
    async (origin) => {
      const timeout = await failureOf(() =>
        newHostedClient({ baseUrl: origin, timeoutMs: 50 }).registry.byHash(WASM_HASH),
      );
      assert.equal(timeout.code, "timeout");
    },
  );

  await withServer(
    (_request, response) => json(response, 200, aggregate({ updated_at: "x".repeat(4096) })),
    async (origin) => {
      const tooLarge = await failureOf(() =>
        newHostedClient({ baseUrl: origin, maxResponseBytes: 512 }).registry.byHash(WASM_HASH),
      );
      assert.equal(tooLarge.code, "response_too_large");
    },
  );
}

/** The configured origin is a pin, and a redirect does not lift it. */
async function originStaysPinned(): Promise<void> {
  // A second origin that really answers — an unresolvable one would fail as a transport error and never
  // reach the check this is about.
  await withServer(
    (_request, response) => json(response, 200, aggregate()),
    async (elsewhere) =>
      withServer(
        (_request, response) => response.writeHead(302, { location: `${elsewhere}/x` }).end(),
        async (origin) => {
          // Refused at the transport by default: the policy does not follow a redirect at all.
          const unfollowed = await failureOf(() =>
            newHostedClient({ baseUrl: origin }).registry.byHash(WASM_HASH),
          );
          assert.equal(unfollowed.status, 0);

          // And with following turned on, the origin check on the *final* URL is what refuses it.
          const followed = await failureOf(() =>
            newHostedClient({ baseUrl: origin, policy: { followRedirects: true } }).registry.byHash(WASM_HASH),
          );
          assert.equal(followed.code, "refused");
          assert.match(followed.message, new RegExp(elsewhere.replace(/[.]/g, "\\.")));
        },
      ),
  );
}

/** A relative base is a browser's own origin; outside one there is nothing to resolve it against. */
function relativeBaseNeedsADocument(): void {
  assert.throws(() => newHostedClient({ baseUrl: "" }), /relative/);
  assert.throws(() => newHostedClient({ baseUrl: "/api" }), /pass an absolute origin/);
  // And a bare host is neither, in a browser or out of one.
  assert.throws(() => newHostedClient({ baseUrl: "api.example.com" }), /needs its scheme/);
}

// TRD §8.3's "without code change", as a type: both modes' `registry` answers `byHash`.
type Assert<T extends true> = T;
type _BothModesAreReaders = [
  Assert<SoveClient["registry"] extends AggregateReader ? true : false>,
  Assert<ReturnType<typeof newHostedClient>["registry"] extends AggregateReader ? true : false>,
];

async function main(): Promise<void> {
  await routes();
  await hostedListSeedsClientSideMode();
  await pathTraversal();
  await declaredFailures();
  await twoHundredIsNotAnAnswer();
  await schemaVersionTolerance();
  await transportFailures();
  await originStaysPinned();
  relativeBaseNeedsADocument();
  console.log(
    "SDK hosted-mode tests passed (routes, hosted list seeds client-side mode, path traversal, declared " +
      "failures, a 200 that is not an answer, schema_version tolerance, transport failures, origin pin, " +
      "relative base)",
  );
}

await main();
