# Submit a contract with curl

Verify a deployed contract from a terminal: check it, point the verifier at its source, submit, follow
the job and read the result. You need `curl`, `jq` and `sha256sum`; on older macOS, use `shasum -a 256`
in its place.

## 1. Name the contract

The commands below talk to the verifier serving this page:

<ThisOrigin />

```sh
NETWORK=testnet
CONTRACT_ID=C...   # your contract's address
```

## 2. Check it

```sh
PREFLIGHT=$(curl -s -X POST "$ORIGIN/api/verification/v1/preflight" \
  -H 'Content-Type: application/json' \
  -d "{\"network\": \"$NETWORK\", \"contract_id\": \"$CONTRACT_ID\"}")

jq '{wasm_hash, build_environment, available_fields, missing_fields}' <<<"$PREFLIGHT"
```

- **`build_environment.kind`** is `chain_named` or `compose` when this verifier can rebuild the contract.
  Any other value means it cannot, and the response says why; see
  [Supported contracts](../introduction/supported-contracts.md).
- **`available_fields`** is what the contract records about its build.
- **`missing_fields`** is what you still have to supply. It is usually `source_uri`: where the source is.

## 3. Point at the source

The verifier rebuilds an archive of your source: a gzip tarball or a zip file. It must be the exact
archive the contract was built from. If `available_fields` includes `source_sha256`, your archive's
SHA-256 has to equal it.

Give the archive in one of two ways.

**At a public URL.** The verifier downloads it. The URL must serve the archive's bytes, not a web page
about them.

```sh
SOURCE_URI=https://example.com/my-contract.tar.gz
SOURCE=$(jq -n --arg uri "$SOURCE_URI" \
  --arg sha "$(curl -sL "$SOURCE_URI" | sha256sum | cut -d' ' -f1)" \
  '{source_uri: $uri, source_sha256: $sha}')
```

**As an upload.** Send the file first. The upload expires after 30 minutes, so submit before then.

```sh
SOURCE=$(curl -s -X POST "$ORIGIN/api/verification/v1/uploads/source" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @my-contract.tar.gz \
  | jq '{upload_id, source_sha256}')
```

Unless you declare the source public, the verifier publishes only the archive's hash, and its URL if you
gave one, and deletes a private upload once no job needs it. To publish the archive itself with the result:

```sh
SOURCE=$(jq '. + {is_public: true}' <<<"$SOURCE")
```

## 4. Submit

```sh
TERMS_VERSION=$(curl -s "$ORIGIN/api/verification/v1/legal" | jq -r .version)
BLDOPT=$(jq -c '.available_fields.bldopt // "" | split(" ") | map(select(. != ""))' <<<"$PREFLIGHT")

BODY=$(jq -n \
  --arg network "$NETWORK" --arg contract "$CONTRACT_ID" --arg terms "$TERMS_VERSION" \
  --argjson source "$SOURCE" --argjson bldopt "$BLDOPT" \
  '{
    target: {network: $network, contract_id: $contract},
    manifest: ({schema: "stellar-submitted-source-verification-manifest-v1", bldopt: $bldopt} + $source),
    accepted_terms_version: $terms
  }')

SUBMITTED=$(curl -s -X POST "$ORIGIN/api/verification/v1/verifications" \
  -H 'Content-Type: application/json' -d "$BODY")
jq . <<<"$SUBMITTED"

JOB_ID=$(jq -r .job_id <<<"$SUBMITTED")
BUILD_LOG_TOKEN=$(jq -r .build_log_token <<<"$SUBMITTED")
```

- **`accepted_terms_version`** says which version of the verifier's <a href="/terms">Terms of Service</a>
  you accept by submitting. Read them before you send it.
- **`bldopt`** is the build's options, one per entry. A contract records them as a single string, which
  the `BLDOPT` line splits. If the contract records none, set them yourself, for example
  `BLDOPT='["--package=my-contract"]'`.
- A `202` with `status: "queued"` means the job exists. Keep `BUILD_LOG_TOKEN`: it is the only way to
  read the job's build log, and it is not shown again.
- A `200` with `status: "incomplete"` means the manifest is not complete yet; `missing_fields` says what
  to add.

To try a submission without publishing anything, make it a dry run before you send it: the job builds
and compares, and the result goes back to you only.

```sh
BODY=$(jq '. + {dry_run: true}' <<<"$BODY")
```

## 5. Follow the job

Poll its status:

```sh
while :; do
  STATUS=$(curl -s "$ORIGIN/api/verification/v1/verifications/$JOB_ID" | jq -r .status)
  echo "$STATUS"
  case "$STATUS" in queued|running) sleep 10 ;; *) break ;; esac
done
```

Or stream it, an event each time it changes and every 10 seconds by default; see
[Progress events](../api/events.md):

```sh
curl -sN "$ORIGIN/api/verification/v1/verifications/$JOB_ID/events"
```

## 6. Read the outcome

```sh
curl -s "$ORIGIN/api/verification/v1/verifications/$JOB_ID" | jq '{status, error, result}'
```

- **`verified`** or **`mismatch`**: the comparison ran. Unless it was a dry run, the result is now
  published.
- **Anything else**: the job failed, and `error` names the cause. Look it up in
  [Failure codes](../api/errors.md#failure-codes).

The build log, when a build ran:

```sh
curl -s "$ORIGIN/api/verification/v1/verifications/$JOB_ID/log" \
  -H "X-Build-Log-Token: $BUILD_LOG_TOKEN"
```

## 7. Read the published result

```sh
WASM_HASH=$(jq -r .wasm_hash <<<"$PREFLIGHT")
curl -s "$ORIGIN/api/verification/v1/wasms/$WASM_HASH.json" | jq .
```

This is the status object anyone can read. [Read a result with curl](./read-a-result.md) shows how to
read every verifier's answer and check a result's evidence yourself.
