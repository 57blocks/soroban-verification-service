# Glossary

**Aggregator** — A service that reads several verifiers and returns each one's result side by side,
without merging them. See [Trust model](./trust-model.md).

**Build image** — The container image a rebuild runs in. It is always pinned by digest
(`…@sha256:<64 hex>`), never by a tag.

**Build log** — The redacted output of a rebuild. When a build ran, the submitter can read it for every
outcome, failures included, with the token returned at submission, for a limited period.

**Composed environment** — A build environment the verifier assembles from official components for a
contract that records its toolchain versions but no build image. Its public identity is
`recipe_sha256`, a hash anyone can recompute from the same inputs.

**Contract ID** — The address of a deployed contract instance. It can be upgraded to run a different
Wasm, so a result is never attached to it directly.

**`contractmetav0`** — A custom section of a Wasm in which the Stellar CLI and the Soroban SDK record
metadata about the build. A Wasm can carry several.

**Dry run** — A submission that builds and compares as usual, returns the result to the submitter, and
publishes nothing.

**Job** — One submission, from the moment it is accepted until it reaches a final state.

**`mismatched`** — A completed comparison in which the rebuilt Wasm differs from the deployed Wasm.
It is a result, not an error.

**Preflight** — A read-only check of a deployed contract that reports whether it can be verified and
what a submission still needs. It never starts a build.

**Recipe** — Everything a rebuild needs: the build image, the build options and arguments, and the
source.

**Report** — The full, immutable record of one verification, stored under its own SHA-256.

**Result root** — The HTTPS base path at which a verifier publishes its results as static files.

**SEP-58** — The Stellar ecosystem proposal that defines the build metadata a contract records so it can
be rebuilt exactly.

**Source archive** — The gzip-compressed tarball or zip file holding the source to rebuild. It is
identified by its SHA-256, `source_sha256`; for a zip that wraps a single archive, that is the inner
archive's hash.

**Status object** — The document at `wasms/<wasm_hash>.json` in a result root that holds a verifier's
current result for one Wasm hash.

**Trusted Verifiers List** — The list of verifiers an aggregator reads, maintained by the aggregator's
operator.

**`verified`** — A completed comparison in which the rebuilt Wasm is identical to the deployed Wasm.

**Verifier** — An identity that rebuilds contracts and publishes results. Its identity is its result
root URL, not its display name.

**Wasm hash** — The SHA-256 of a deployed Wasm binary. Results are keyed by it.
