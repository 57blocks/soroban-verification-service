# Use the SDK

`soroban-verification-client` is a read-only TypeScript client for verification results. It reads an
aggregator's Query API, or every verifier's result root directly, validates each document it reads, and
returns the same shape either way. It does not submit contracts; for that, see
[Verify from CI](../developers/verify-from-ci.md).

[Read a result with the SDK](../quick-start/read-with-the-sdk.md) is the five-minute version of this
page.

## Install

```sh
npm install soroban-verification-client
```

| Install | Gets you |
| --- | --- |
| `soroban-verification-client` | The newest stable release, the `latest` tag |
| `soroban-verification-client@staging` | The newest release candidate |
| `soroban-verification-client@dev` | A build of the newest change to the SDK on `main` |
| `soroban-verification-client@0.1.0` | Exactly that version |

`latest` never holds a prerelease. `staging` and `dev` move with every qualifying change and are for
trying a change before its release, so pin an exact version in anything you ship. Every version is
published from the repository's release workflow with npm provenance, which `npm audit signatures`
checks. Changes are listed in the [changelog](../resources/changelog.md); while the version is `0.x`, a
minor release can break the API, and the changelog names each break.

**Requirements:**

- **Node.js 20 or later, or a browser in a secure context.** The SDK uses `fetch`, `AbortSignal.timeout`
  and WebCrypto. Over plain HTTP, a browser has no WebCrypto; see [Check the evidence](#check-the-evidence).
- **ESM only.** From CommonJS, load it with `await import("soroban-verification-client")`.
- **One copy of each validation library.** `class-validator`, `class-transformer` and `reflect-metadata`
  are dependencies, and their metadata lives in a module-level singleton. If your dependency tree holds
  two copies of one of them, validation stops checking anything and still reports success. Run
  `npm ls class-validator class-transformer reflect-metadata` to check.
- **Only what the package exports is supported.** Imports from inside `dist/` can change in any release.

## Two clients

| | `newHostedClient` | `newClient` |
| --- | --- | --- |
| Reads | One aggregator's Query API | Every listed verifier's result root |
| Requests per query | One | One per active verifier |
| Look up by contract address | Yes, `byContract` | No: resolving an address needs a ledger read |
| A slow verifier | Already absorbed by the aggregator | Delays the whole answer, up to the timeout, then is listed as `timeout` |
| A paused verifier | Its earlier results are still served | Skipped |
| Trusts | The aggregator to report what verifiers published | Only the verifiers it reads |

Both return an `AggregatedWasmStatus`, so code that reads the answer does not care which produced it.
The two also combine: a hosted client hands out the aggregator's list of verifiers, and a `newClient`
built from that list reads the active ones directly.

```js
const hosted = newHostedClient({ baseUrl: "https://verifier.example.org" });
const client = newClient({ tvl: await hosted.verifiers() });
```

## The answer

```json
{
  "schema": "stellar-verification-aggregate",
  "schema_version": "1.0",
  "wasm_hash": "96ae13fb…",
  "updated_at": "2026-10-20T08:00:00.000Z",
  "agreement": "single",
  "unavailable_verifiers": [],
  "source_code_verifications": [
    {
      "verifier": { "url": "https://results.verifier.example", "name": "Example Verifier" },
      "status": "verified",
      "recipe_source": "on_chain_metadata",
      "image_trust_level": "official_trusted",
      "processed_at": "2026-10-15T07:46:30.802Z",
      "schema_version": "1.0",
      "results_urls": [{ "type": "report", "location": "verifier_self_storage", "url": "…", "sha256": "…" }]
    }
  ]
}
```

- **`source_code_verifications`** holds one entry per verifier with a result for the Wasm.
  `verifier.url`, a verifier's result root, is its identity. Both clients take one entry from each
  result root: the one whose `verifier.url` names that root, or the first entry, with the root filled
  in, when no entry names a URL. An entry claiming another verifier's root is not shown, and a
  document with no entry of its own counts as no result from that verifier.
- **`status`** is `verified`, `mismatched` or `unverified`. A peer can publish a value outside that
  list; `displayStatusOf(entry)` maps anything else to `unverified`, which is how to show it.
- **`agreement`** is `no_data`, `single`, `unanimous_verified`, `unanimous_mismatched`, `disputed` or
  `unverified_only`. It describes the entries; it does not decide between them.
- **`unavailable_verifiers`** lists each verifier that could not be read, with a `reason`:
  `fetch_failed`, `timeout`, `refused` (the fetch policy blocked the request) or `invalid_response`.
- **`updated_at`** is when the answer was put together, not when any result changed.

The SDK never merges entries into one verdict. Which verifiers you trust, and what you show when they
disagree, is your decision; see [Interpret multi-verifier results](./interpret-multi-verifier-results.md).

## The hosted client

```js
import { newHostedClient, queryApiFailureOf } from "soroban-verification-client";

const hosted = newHostedClient({ baseUrl: "https://verifier.example.org" });

const byContract = await hosted.registry.byContract("mainnet", "C...");
const byHash = await hosted.registry.byHash(byContract.wasm_hash);
const verifiers = await hosted.verifiers();
```

| Method | Calls |
| --- | --- |
| `registry.byContract(network, contractId)` | `GET /api/query/v1/contracts/{network}/{contractId}`. `network` is `mainnet` or `testnet` |
| `registry.byHash(wasmHash)` | `GET /api/query/v1/wasms/{wasmHash}` |
| `verifiers()` | `GET /api/query/v1/verifiers`: the aggregator's Trusted Verifiers List, every verifier on it with its `status`, paused and disabled ones included. The aggregator reads only the `active` ones |

`baseUrl` is the aggregator's origin, with its scheme. In a browser, a relative base such as `""` means
the page's own origin. Options:

| Option | Default |
| --- | --- |
| `timeoutMs` | `5000`. The request is cancelled when it runs out |
| `maxResponseBytes` | 1 MiB |
| `policy` | See [The fetch policy](#the-fetch-policy) |
| `fetch` | The global `fetch` |

Each method throws `QueryApiError` and nothing else. Read `error.failure`, or call
`queryApiFailureOf(error)` on anything you catch, to get `{ status, code, message }`. `status` is `0`
when no response arrived.

| `code` | Means |
| --- | --- |
| `invalid_network`, `invalid_contract_id` | The network or the address is malformed (400) |
| `contract_not_found` | Nothing at that address runs a Wasm (404) |
| `address_resolution_failed` | The aggregator could not read the ledger (502). Retry |
| `aggregation_unavailable` | The aggregator has not finished its first read of the verifiers since it started (503). Retry; it does not mean there are no results |
| `rate_limited` | Too many requests (429). Slow down |
| `unreachable`, `timeout` | No response, or none in time. An unfollowed redirect also ends as `unreachable` |
| `refused` | The fetch policy blocked the request, for example a URL outside the base origin |
| `response_too_large`, `invalid_response` | The body is over the size limit, or is not a valid answer |
| `http_<status>` | Any other failure without a code of its own. A code the aggregator declares, such as `internal_error`, is passed through as it is |
| `unknown` | From `queryApiFailureOf`, for an error that is not a `QueryApiError` |

A hash the aggregator has no result for is not an error: the answer has no entries and `agreement` is
`no_data`. Validate a Wasm hash, 64 lowercase hexadecimal characters, before you send it.

## The direct client

`newClient` takes a **Trusted Verifiers List**, the document that names the verifiers to read, as data.
Loading it is your job: from an aggregator, as above, or from a file you keep.

```js
import { newClient } from "soroban-verification-client";

const client = newClient({
  tvl: {
    schema: "stellar-trusted-verifiers-list",
    schema_version: "1.0",
    updated_at: "2026-10-20T00:00:00.000Z",
    verifiers: [{ url: "https://results.verifier.example", status: "active", display_name: "Example Verifier" }],
  },
});
```

Each entry needs a `url`, the verifier's result root, and a `status` of `active`, `paused` or `disabled`.
`display_name`, `manifest_url` and `bulk_load_url` are optional; `id` and `trust_tier` are labels for
your own use, and the SDK does not interpret them. If the list uses relative URLs, pass `baseUrl` to
resolve them. An invalid list throws `SchemaValidationError` when the client is created.

| Member | Does |
| --- | --- |
| `verifiers` | The list's entries, with each `url` made absolute |
| `registry.byHash(wasmHash, options?)` | Reads every `active` verifier's status object for the Wasm and aggregates them. Never rejects because a verifier failed |
| `registry.statusObject(verifier, wasmHash, options?)` | Reads one verifier's own status object, unaggregated. Throws if it cannot be read |
| `registry.bulkLoad(verifier, { cursor?, limit? })` | One page of the verifier's list of results, oldest change first. Throws if the entry has no `bulk_load_url` |
| `discover()` | Reads each verifier's manifest and policy. Never rejects |
| `results.verifyUrl(link)` | Fetches a report or other result file and checks its hash; see below |

A verifier with no result for the Wasm adds no entry. `paused` and `disabled` verifiers are skipped
without appearing in `unavailable_verifiers`.

`bulkLoad` returns `{ order, cursor, records }`, where each record is `{ wasm_hash, updated_at }`. Pass
`cursor` back to get the next page. On the last page it is `null`, so keep the cursor that fetched the
last page and start the next walk from it.

`discover()` returns one outcome per verifier, in the list's order:

| `outcome` | Means |
| --- | --- |
| `available` | Both `manifest` and `policy` were read |
| `not_advertised` | The entry has no `manifest_url`, so nothing was fetched. Nothing is wrong |
| `unavailable` | The manifest or its policy could not be read; `reason` says why, as for `unavailable_verifiers` |

**Validation.** `byHash` and `statusObject` take `{ validation: "default" | "strict-base" }`. The default
accepts fields a verifier adds beyond version 1.0 of the format. `"strict-base"` drops them before
validating, at the top level of the document and of each entry. Either way, a document from a later
minor version, such as `1.3`, is accepted, and one from version `2.0` is refused.

## Check the evidence

A status object links its report, and sometimes other files, under `results_urls`, each with the
SHA-256 of its bytes. `client.results.verifyUrl(link)` fetches one and checks it:

```js
const fetched = await client.results.verifyUrl(link);
// fetched.verified is true; fetched.bytes are the published bytes; fetched.origin is where they came from.
```

- **A link with no `sha256` is refused** with `UnverifiableEntryError`, before anything is fetched. Pass
  `{ allowUnverified: true }` to fetch it anyway; the result then says `verified: false`.
- **Bytes that do not match throw `HashMismatchError`**, and are not returned.
- **`verifyUrl` reads only from the origins the list names.** The standalone
  `fetchAndVerifyResultUrl(link, options)` does the same check without that restriction, under the
  default policy otherwise.
- **An archived copy is on another origin.** A link with `"location": "arweave"` is not on any listed
  verifier's origin, so `verifyUrl` refuses it; check it with `fetchAndVerifyResultUrl` instead.
- **Without WebCrypto**, as in a browser page served over plain HTTP, pass a `hasher`: an async function
  from the bytes to their hexadecimal SHA-256.

The bytes are input from a third party. The SDK never parses, renders or follows them. If you show a
user a link from a result, show them where it leads before they follow it.

## The fetch policy

Every request passes a policy first, because a document from one verifier decides which URL is requested
next. Override any setting with the `policy` option.

| Setting | Direct client | Hosted client |
| --- | --- | --- |
| `allowedSchemes` | `["https:"]` | The base URL's scheme |
| `allowedOrigins` | The origins the list names | The base URL's origin |
| `blockPrivateRanges` | `true`: loopback, private and link-local addresses, and `localhost`, are refused | `false` |
| `followRedirects` | `false`: a redirect fails the request | `false` |
| `maxResponseBytes` | 1 MiB, counted as the body arrives | 1 MiB |
| `timeoutMs` | 5000, and the request is cancelled | 5000 |

When redirects are allowed, the final URL is checked again. To read a verifier on your own machine,
relax both settings by name:

```js
const client = newClient({ tvl, policy: { allowedSchemes: ["https:", "http:"], blockPrivateRanges: false } });
```

The private-range check looks at the URL only; it does not resolve host names. On a server, a host name
can still resolve to an internal address, so when you fetch URLs that someone else chose, run the
client where the network itself limits what it can reach.
