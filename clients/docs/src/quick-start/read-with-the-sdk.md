# Read a result with the SDK

Find out whether a contract's source is verified, and by whom, from TypeScript or JavaScript, then check
the evidence yourself. The SDK, `soroban-verification-client`, is read-only and needs no account and no
key. You need Node.js 20 or later.

<ThisOrigin />

## 1. Install

```sh
mkdir read-a-result && cd read-a-result
npm init -y && npm pkg set type=module
npm install soroban-verification-client
```

The package is ESM only, so the project is set to `"type": "module"`.

## 2. Every verifier's answer for a contract

Save this as `read.js`:

```js
import { newClient, newHostedClient } from "soroban-verification-client";

const hosted = newHostedClient({ baseUrl: process.env.ORIGIN });
const aggregate = await hosted.registry.byContract(process.env.NETWORK, process.env.CONTRACT_ID);

console.log(aggregate.wasm_hash, aggregate.agreement);
for (const entry of aggregate.source_code_verifications) {
  console.log(entry.verifier.url, entry.status, entry.image_trust_level, entry.recipe_source);
}
console.log("unavailable:", aggregate.unavailable_verifiers);
```

Run it with the origin above and a contract address:

```sh
ORIGIN=https://verifier.example.org NETWORK=testnet CONTRACT_ID=C... node read.js
```

`newHostedClient` reads an aggregator's [Query API](../integrators/query-across-verifiers.md). The
address is resolved to the Wasm it runs right now, and the answer is one entry per verifier that has a
result for that Wasm:

- **`status`** is `verified` or `mismatched` for a completed comparison, and `unverified` otherwise.
- **`agreement`** sums the entries up, for example `unanimous_verified` or `disputed`. It is a summary,
  not a verdict: which verifiers to trust, and what to show, is your decision. See
  [Trust model](../introduction/trust-model.md).
- **`unavailable_verifiers`** names any listed verifier the aggregator could not read.

A failed request throws `QueryApiError`, whose `failure.code` says why: for example
`contract_not_found` when nothing at the address runs a Wasm.

## 3. Ask the verifiers yourself

The aggregator's answer is its summary of what it last read. To read each verifier's own result instead,
build a second client from the aggregator's list of verifiers. Add to `read.js`:

```js
const client = newClient({ tvl: await hosted.verifiers() });
const direct = await client.registry.byHash(aggregate.wasm_hash);

for (const entry of direct.source_code_verifications) {
  console.log("direct:", entry.verifier.url, entry.status);
}
```

`newClient` fetches each active verifier's status object from its **result root**, the place it
publishes its results as static files, and aggregates them in your process. No API is involved, and the
answer has the same shape. A verifier that cannot be read appears in `unavailable_verifiers` with a
`reason`; one failing verifier never fails the call.

## 4. Check the report

Each entry points at the full report and gives its SHA-256. A report is stored under its own hash and
never changes, so the SDK can check that the bytes it reads are the bytes that were published. Add:

```js
const report = direct.source_code_verifications
  .flatMap((entry) => entry.results_urls ?? [])
  .find((link) => typeof link === "object" && link.type === "report");

if (report) {
  const fetched = await client.results.verifyUrl(report);
  const { result, build_recipe } = JSON.parse(new TextDecoder().decode(fetched.bytes));
  console.log("report intact:", fetched.verified, result.status_summary, build_recipe?.build_image);
}
```

`report intact: true` means the bytes match the published hash. The report also records the recipe that
rebuilt the contract, the build image, the source's hash and the comparison.

`verifyUrl` refuses an entry with no `sha256`, and throws `HashMismatchError` if the bytes do not match.
It fetches only from the verifiers' own origins, over HTTPS. Treat the report's contents as data that
someone else wrote: the SDK returns the bytes and never follows the links inside them.

## Next

- [Use the SDK](../integrators/use-the-sdk.md) covers both clients, their options, errors and the fetch
  policy.
- [Interpret multi-verifier results](../integrators/interpret-multi-verifier-results.md) explains how to
  turn the entries into what you show.
- [Result documents](../api/result-documents.md) describes every field.
