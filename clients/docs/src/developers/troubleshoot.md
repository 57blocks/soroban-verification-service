# Troubleshoot a failed verification

Start from where it stopped. A **refused request** never became a job. A **failed job** ran but reached
no verdict. A **mismatch** reached a verdict you did not want. Each has a different fix.

What to read, in order:

1. The job's `status`, and its `error`: a stable code. `result.detail` adds a sentence. The console shows
   both in the banner.
2. The [failure code table](../api/errors.md#failure-codes), which gives every code a meaning and a fix.
3. The build log, when a build ran. Only the submitter can read it, with the token returned at
   submission; see [Use the console](./use-the-console.md#the-build-log).

## A refused request

The verifier answers with an HTTP error, and nothing was created. The ones a developer meets most:

| `error` | Fix |
| --- | --- |
| `terms_acceptance_required`, `terms_version_outdated` | Fetch `GET /api/verification/v1/legal`, read the terms, and send its `version` as `accepted_terms_version` |
| `invalid_manifest` | `detail` names the field. Most often a `bldopt` written as a short flag or with a space before its value; write `--flag=value` |
| `policy_rejected` | A `--manifest-path` that is absolute or leaves the archive. Make it relative to the archive's root |
| `source_archive_not_chain_recorded` | The contract records a different `source_sha256`. Submit the archive it was built from; no other archive will do |
| `upload_expired`, `upload_not_found` | Uploads last 30 minutes. Upload again, then submit |
| `rate_limited` | Wait for the next minute; see [Verify from CI](./verify-from-ci.md#rate-limits) |

[Errors](../api/errors.md#request-errors) lists them all.

## A failed job

### `source_unavailable`: the source could not be used

The verifier could not get or unpack your archive. The code says which:

- **`source_uri_refused`, `source_uri_not_materialized`**: the URL is not HTTPS, points at a private
  address, redirects too often, or did not answer. Check it opens from an ordinary network, or upload
  the archive instead.
- **`source_hash_mismatch`**: the URL served different bytes from the hash you gave. The host may
  regenerate the archive; host a file that does not change.
- **`source_archive_*`**: the archive breaks a rule: its format, size, entry count, a link or an unsafe
  path. See [Prepare your source](./prepare-your-source.md#the-archive).
- **`private_upload_unavailable`**: the upload was gone by the time the job ran. Upload and submit again.

### `policy_rejected`: the recipe asks for something the verifier will not do

- **`manifest_path_escapes_source`, `absolute_manifest_path_not_supported`**: a path option leaves the
  archive.
- **`recorded_build_option_unsupported`**: the Stellar CLI in the build image rejects one of the build
  options. If the option came from the contract's own metadata, the contract cannot be rebuilt as
  recorded.
- A recorded toolchain that can never be composed, such as a Stellar CLI version that was never released.

### `not_attempted`: the contract records an environment this verifier will not run

The build image is not one this verifier accepts, or the recorded toolchain cannot be reproduced. This is
a property of the deployed Wasm, so no submission changes it. A future version of the contract can be
built so that it can be verified; see [Make your contract verifiable](./make-your-contract-verifiable.md).

### `build_failed`: the build did not produce the Wasm

Read the build log first. The usual causes:

- **`rebuild_command_failed`**: the compiler or the CLI failed. Check the `--manifest-path` and
  `--package`, and that the archive builds on its own with the same options.
- **`manifest_path_not_found`**: no `Cargo.toml` at the given path. Paths are relative to the archive's
  root, after a single top-level directory is stripped.
- **`dependency_prefetch_failed`**: dependencies could not be downloaded from `Cargo.lock`. Check the
  lockfile is in the archive and up to date.
- **`dependency_prefetch_policy_rejected`**: a dependency comes from a host this verifier does not allow.
- **`source_cargo_source_override_conflict`**: `.cargo/config.toml` replaces a crate source. Remove the
  replacement.

A failure on the verifier's side, or a build that ran out of time, is retried automatically, so the job
can return to `queued` before it settles. If it still fails, resubmit later, or tell the verifier's
operator.

## A mismatch

The rebuild worked, and produced different bytes. The verifier's comparison, on the result page and in
`result.sandbox_diagnostics`, shows how the two Wasm files differ; see
[Reading a mismatch](./understand-a-result.md#reading-a-mismatch). Then check, in this order:

1. **The archive.** It has to be the source that built the deployed Wasm, at the same revision, with
   the same `Cargo.lock`.
2. **The build options.** Every option the original build used, in the same form. A missing `--optimize`
   or a different `--package` is enough.
3. **The environment.** For a contract without a recorded image, the verifier composes one from the
   recorded Stellar CLI and Rust versions; anything the original build relied on beyond those, it cannot
   know.

### Reproduce the rebuild yourself

You can run the rebuild the verifier ran, and compare hashes before you submit again. Read the recipe
from the deployed Wasm:

```sh
stellar contract info meta --wasm deployed.wasm
```

Unpack the archive, then build it with the recorded image and options, offline, and passing back every
other metadata entry the Wasm records, in the same order, as the verifier does:

```sh
docker run --rm -v "$PWD:/source" -w /source --entrypoint stellar "$IMAGE" contract build \
  --manifest-path=contracts/my-contract/Cargo.toml --package=my-contract --optimize \
  --meta "bldimg=$IMAGE" --meta "source_sha256=$SOURCE_SHA256"   # …each recorded entry
sha256sum target/wasm32v1-none/release/my_contract.wasm   # the path the build printed
```

The verifier differs from this command in a few ways that do not change the output: it downloads
dependencies with `cargo vendor --locked` first, then builds with no network and a read-only source,
and it uses the image's own Rust toolchain even if the source names another. If your hash matches the
deployed Wasm and the verifier's does not, report it to the verifier's operator with both hashes.
