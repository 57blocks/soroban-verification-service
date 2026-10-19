# Build environments — spec

As built. See `Verified by:` on each claim.

## 1. The deployed Wasm's chain record selects the class

There is no user-selected environment and no pair-to-image catalogue on the request path. The
classifier reads only what the chain record carries:

| Class | Chain record | Path |
| --- | --- | --- |
| `chain_named` | SEP-58 `bldimg`, already policy-checked | used as-is |
| `compose` | `(cliver, rsver)` pair, no `bldimg` | composed from official components |
| `unsupported` | no usable toolchain identity | fails classification, never silently retried |

Verified by: `packages/core/src/build-environment.ts` (`classifyBuildEnvironment`),
`services/orchestrator-svc/test/build-environment-resolver.spec.ts`.

## 2. Resolution is pure; materialization is not

Resolution (which class, and for `compose`, which `(pair, template_version)` intent) touches no
network and no database, and runs safely on every scheduler tick. Materialization — actually
composing and pushing an image — is a separate, cached step: environments are keyed by
`recipe_sha256`; one caller claims a pending row, the composer builds and pushes once, and later
callers reuse the ready row.

Verified by: `services/orchestrator-svc/src/modules/build-environments/deterministic-build-environment-resolver.service.ts`,
`services/orchestrator-svc/src/modules/build-environments/caching-build-environment-materializer.service.ts`,
`services/orchestrator-svc/test/environment-materializer.spec.ts`.

## 3. Composition inputs are official-only

See [rule 16 of `docs/invariants.md`](../invariants.md) for the invariant this enforces. Concretely,
the composer fetches and checksum-verifies, from official sources only: a digest-pinned base image,
a checksum-pinned rustup installer plus the exact `rsver` toolchain, and the stellar-cli release
asset addressed and checksummed by GitHub's own release API — never a submitter-supplied field.

Verified by: `services/composer/src/modules/composer/components.ts` (`fetchAndVerifyComponents`,
`resolveStellarCliAsset`), `services/composer/test/components.spec.ts`.

## 4. Identity: `recipe_sha256` vs. `image_digest`

`recipe_sha256` hashes the canonical `(pair, template_version, components)` recipe and is the public,
portable identity — what a third party recomputes to confirm the same environment. `image_digest` is
only this verifier's own ECR pull coordinate for it. A `Rebuild` keyed by a bare 64-hex value is a
composed identity; anything else is a chain-named image reference — one persisted column, two kinds
of value.

Verified by: `packages/core/src/build-environment-hash.ts` (`composedEnvironmentRecipeHash`),
`packages/core/src/build-environment.ts` (`parseRebuildEnvironmentIdentity`).

## 5. Trust boundary: the composer never sees submitted input

The composer's job params carry only the chain-derived pair and a verifier-owned template version —
no source archive, no source URI, no submitter-controlled build arguments. Untrusted source runs
later, in the builder, which receives only a digest-pinned image and the normal source reference
([rule 1](../invariants.md)). A component download or checksum failure fails preparation and
publishes no verdict — it never becomes a `mismatched` result.

Verified by: `services/composer/src/modules/composer/composer.service.ts` (`ComposerJobParams` as
its sole input shape), `services/builder/test/trust-boundary.spec.ts`.

## 6. Unsupported and malformed inputs fail closed

A missing pair, an undated-nightly `rsver`, a `cliver` with no matching stellar-cli release, or a
toolchain that does not distribute a target the template requires — each is a distinct, named
failure reason, never a silent fallback and never a guess between ambiguous candidates.

Verified by: `services/orchestrator-svc/test/build-environment-resolver.spec.ts` (`missing_toolchain_pair`,
`undated_nightly`), `services/composer/test/components.spec.ts` (`unreleased_cli`,
`toolchain_target_unavailable`, `ambiguous_release_asset`).

## 7. Every published report carries the full recipe

See [rule 18 of `docs/invariants.md`](../invariants.md). A composed environment's published report
includes `recipe_source`, the recipe hash, the ECR reference, template version, pair, and every
component's source and checksum — so a third party can rebuild an equivalent environment without
trusting this verifier's cache.

Verified by: `packages/storage-layout/src/shapes.ts` (`recipe_source`, `build_recipe` on the report
shape).

## What this document does not cover

Infrastructure requirements for running a composer fleet (its own Batch queue, IAM, ECR repository)
are a deployment contract, not an application-level rule — see the documentation site's
[Requirements](../../clients/docs/src/self-hosting/requirements.md).
