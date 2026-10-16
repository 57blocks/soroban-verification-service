# Understand a result

A job ends in a verdict or a failure. A verdict is published as evidence anyone can check; a failure is
told only to you. This page explains what each part of a result says, and what it does not.

## The verdict

A rebuild that runs to the end produces one of two verdicts:

| Job status | Published as | Means |
| --- | --- | --- |
| `verified` | `verified` | The rebuilt Wasm is byte-for-byte the deployed Wasm |
| `mismatch` | `mismatched` | The rebuild ran, and produced a different Wasm |

The job and the published record spell the second one differently: a job says `mismatch`, a status
object says `mismatched`.

A verdict says that **this verifier** rebuilt **this source** with **this recipe** and got, or did not
get, the deployed bytes. It is not a security review of the code, and it is not a conclusion other
verifiers have to share; see [Trust model](../introduction/trust-model.md).

Any other final status (`build_failed`, `source_unavailable`, `policy_rejected`, `not_attempted`) means
the job never reached a verdict. Nothing is published for it; see
[Troubleshoot a failed verification](./troubleshoot.md).

A [dry run](./verify-from-ci.md#try-it-first-with-a-dry-run) reaches a verdict like any other job, and
publishes nothing.

## Where a verdict is published

The verifier writes two documents to its **result root**, the static files it serves over HTTPS:

- the **status object** for the Wasm hash, at `wasms/<wasm_hash>.json`: this verifier's current result
  for that Wasm;
- the **report**, at `reports/<sha256>.json`: the full record of this one verification. Its file name is
  the SHA-256 of its own bytes, and it never changes once written.

The status object points at the report. The console's result page links to both, and
[Read a result with curl](../quick-start/read-a-result.md) fetches them.

## The status object

The status object holds one entry from this verifier. Its main fields:

| Field | Says |
| --- | --- |
| `status` | `verified` or `mismatched`. While a verification of the Wasm is queued or running, the API's copy answers `202` with an `unverified` entry instead; the file in the result root is unchanged |
| `recipe_source` | Where the build recipe came from: `on_chain_metadata` when the contract recorded it and the rebuild used it unchanged, `submitted` when any of it came from the submission |
| `image_trust_level` | How the build environment was chosen: `official_trusted` for an official Stellar CLI image the contract names, `upstream_pinned` for an environment the verifier composed from official components |
| `bldimg`, `bldarg`, `bldopt` | The build image, arguments and options the rebuild ran |
| `source_sha256` | The hash of the source archive that was rebuilt |
| `source_uri` | Where that archive was fetched from, when it came from a URL |
| `rebuilt_hash` | The hash the rebuild produced. Present only on a `mismatched` entry |
| `processed_at` | When the verdict was reached |
| `results_urls` | The report, and any permanent copy of it, each with its SHA-256 |
| `verified_source_code_uris` | Where the source itself can be downloaded. Present only when the source was declared public |

`recipe_source: on_chain_metadata` with `image_trust_level: official_trusted` is the strongest result:
everything that went into the rebuild was fixed on chain before you submitted anything.

### When a Wasm is verified more than once

The status object keeps one entry per verifier, and a newer verdict replaces the older one, with one
exception: a `mismatched` verdict never replaces a `verified` one. Once a Wasm is verified, a later
submission of the wrong source cannot undo it. Its report is still written to the result root, and its
source too if it was declared public, but the status object, which is what readers consult, keeps
`verified`.

## The report

The report records everything the verifier did, so you can check it, or repeat it:

- **`source`**: the archive's hash, whether it was declared public, the URL it came from, and the
  `source_sha256` the contract records on chain, when it records one.
- **`build_recipe`**: the build image and options. For a composed environment, it lists every component
  with its source and checksum, so you can assemble the same environment yourself.
- **`provenance`**: where the recipe came from, and `build_isolation: network_isolated` for a build that
  ran with no network.
- **`result`**: the expected and rebuilt hashes, whether they matched, and the sandbox's diagnostics.

To check that you hold the report the verifier published, hash it and compare with its file name:

```sh
curl -s "$REPORT_URL" -o report.json
sha256sum report.json   # equals the <sha256> in reports/<sha256>.json
```

### Permanent copies

A verifier can also archive each report to Arweave. When it does, the status object gains a second
`results_urls` entry, with `location: arweave` and the same SHA-256, a little after the verdict is
published. Whether a verifier archives at all is its operator's choice.

## Reading a mismatch

A mismatch is a finished rebuild, so the verifier can tell you how the two Wasm files differ. The job's
result, and the console's result page, compare them:

- **imports and exports**: a difference usually means different source, dependencies, SDK version or
  feature flags;
- **function and code counts**: a difference means the rebuilt contract is not the same program;
- **custom sections**: a difference points to embedded metadata, the contract spec, or build flags;
- **size**, section by section: with the same function counts, a size difference points to optimizer,
  metadata or toolchain settings.

These are hints, not a second verdict: a contract is verified only by an exact match. A mismatch
records the hash the rebuild produced, so the next attempt can tell whether anything changed.
[Troubleshoot a failed verification](./troubleshoot.md#a-mismatch) goes through the usual causes.
