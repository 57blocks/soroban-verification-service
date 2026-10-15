# Read a result with curl

Find out whether a contract's source is verified, and by whom, then check the evidence yourself. Reading
needs no account and no key. You need `curl`, `jq` and `sha256sum`; on older macOS, use `shasum -a 256`
in its place.

<ThisOrigin />

## 1. Every verifier's answer for a contract

```sh
NETWORK=testnet
CONTRACT_ID=C...   # the contract's address

AGGREGATE=$(curl -s "$ORIGIN/api/query/v1/contracts/$NETWORK/$CONTRACT_ID")
jq '{
  wasm_hash,
  agreement,
  unavailable_verifiers,
  entries: [.source_code_verifications[] | {verifier: .verifier.url, status, image_trust_level, recipe_source}]
}' <<<"$AGGREGATE"
```

The address is resolved to the Wasm it runs right now, and the answer is one entry per verifier that has
a result for that Wasm:

- **`status`** is `verified` or `mismatched` for a completed comparison, and `unverified` otherwise.
- **`agreement`** sums the entries up, for example `unanimous_verified` or `disputed`. It is a summary,
  not a verdict: which verifiers to trust, and what to show, is your decision. See
  [Trust model](../introduction/trust-model.md).
- **`unavailable_verifiers`** names any listed verifier whose latest read failed.

This route needs a deployment that runs the Query API. If yours runs only a verifier, start from a Wasm
hash in step 2.

## 2. One verifier's answer, by Wasm hash

```sh
WASM_HASH=$(jq -r .wasm_hash <<<"$AGGREGATE")
curl -s "$ORIGIN/api/verification/v1/wasms/$WASM_HASH.json" | jq .
```

This is the verifier's own status object for the Wasm. While any verification of that Wasm is queued or
running, this route answers `202` with an `unverified` entry, even when a result is already published.
Read the result root, in step 3, to see the published result in the meantime.

## 3. Straight from the result root

Each entry's `verifier.url` is that verifier's **result root**: the place it publishes its results as
static files. Reading it needs no API at all.

```sh
ROOT=$(jq -r '.source_code_verifications[0].verifier.url' <<<"$AGGREGATE")
curl -s "$ROOT/wasms/$WASM_HASH.json" -o status.json
jq . status.json
```

What a result root answers for a Wasm it has no result for depends on the host serving it: a `404`, or a
`403` from a storage host that hides which files exist.

## 4. Check the report

The status object points at the full report, and gives the report's SHA-256 beside its URL. A report is
stored under its own hash and never changes, so you can check that the bytes you read are the bytes that
were published:

```sh
REPORT=$(jq -c '[.source_code_verifications[].results_urls[]? | select(.type == "report")][0]' status.json)
curl -s "$(jq -r .url <<<"$REPORT")" -o report.json
echo "$(jq -r .sha256 <<<"$REPORT")  report.json" | sha256sum -c -
```

`report.json: OK` means the report is intact. It records the recipe that rebuilt the contract, the build
image, the source's hash and the comparison:

```sh
jq '{result, build_recipe, source, image_trust_level}' report.json
```

Where the verifier also archives its reports, `results_urls` carries a second entry with
`"location": "arweave"`. The archived copy has the same SHA-256.

## Next

- [Result documents](../api/result-documents.md) describes every field and gives the JSON Schemas.
- [Trust model](../introduction/trust-model.md) explains what an entry's `recipe_source` and
  `image_trust_level` say about how much weight it carries.
