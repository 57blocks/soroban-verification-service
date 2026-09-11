# ADR-009: Build environments are composed from official components

> **Status**: Accepted 2026-07-30
> **Scope**: how rebuild environments for cli-legacy (and, if policy extends, cli-none) are
> provisioned; the trusted-environment policy model; what each published result must carry
> **Evidence**: `../evidence/2026-07-30-corpus-scan.md`,
> `../evidence/2026-07-30-poc-composed-image.md`

## Context

Rebuilding a cli-legacy contract requires a container carrying the exact toolchain that produced
it — the `(cliver, rsver)` pair recorded in its Wasm. Official image coverage of that demand is a
small head, not the body, and the gap is structural — spec **TD3** owns the measured numbers and
their source. Serving the class at all means someone other than SDF provides most environments.

Two provisioning models were considered: **pre-build and host** (~93 images in a registry we
operate, with availability and retention obligations, and a "who vouches for these blobs" question
only SDF could answer) versus **compose at verification time** from a public template.

SDF settled the trust question on 2026-07-30 (Steph Orpilla): what qualifies an environment for a
`verified` result is **reproducibility, not publisher identity** — every input pinned (image by
digest, toolchain pieces by checksum, dependencies by lockfile); the environment recreatable by
anyone from a published recipe; the recipe and checksums **published with each result** — and
composition was explicitly called better than an allowed-image set.

## Decision

Rebuild environments the ecosystem does not publish are **verifier composed images**: assembled at
verification time by a public Dockerfile template from

- the exact Rust toolchain, fetched by version from the Rust project's immutable release archives
  (rustup-verified);
- the stellar-cli release binary, verified against the per-asset digest GitHub's release API
  publishes (SDF publishes no separate checksum files; asking for SHA256SUMS is an open upstream
  request);
- a digest-recorded Debian slim base (recorded for auditability; it does not reach the Wasm bytes —
  wasm links no system library and the linker ships with the toolchain).

Dependencies are not part of the environment; they follow each submission's `Cargo.lock`, which
cargo verifies per-crate.

**Constraints that are part of the decision, not implementation detail:**

1. **Composition inputs come only from on-chain metadata and official immutable sources. No
   submitter-supplied field ever participates.** A submitter who can influence what counts as a
   trusted environment can make arbitrary source verify.
2. **Component provenance is required on top of SDF's stated criteria (TRD §7.2 owns their
   normative text).** The criteria exclude the irreproducible; they do not exclude a faithfully
   pinned *malicious* toolchain, which could emit the deployed bytes regardless of source and forge
   `verified`.
3. **Every result carries its environment recipe and component checksums** (SDF's third
   criterion), so any third party can rebuild an equivalent environment and re-derive the verdict.
4. **No shared multi-verifier registry.** Anyone who can push to a registry others trust by name
   can poison them; each verifier composes its own environments from the same public template, and
   trust follows verifier identity — consistent with the per-verifier model.
5. Composition happens on the trusted side, off the request path; it needs network and container
   build capability, which rides the same infrastructure decision as the builder sandbox
   (TRD §10 item 12).

Published label: `upstream_pinned` — SDF declined an `sdf_`-prefixed name and delegated the choice,
2026-08-03 (TRD §7.2, Settled).

**Resolution mechanism.** Every supported cli-legacy `(cliver, rsver)` pair is composed directly.
ADR-017 defines the durable form: compose once per pair/template version, cache the materialized image
by digest in this verifier's private registry, and publish the complete component recipe with each
result. Runtime resolution contains no pair-to-image catalogue.

## Consequences

- The verifier operates a private registry as a durable cache; consumers never trust it by name.
- Third-party verifiers reproduce an environment from the published component recipe rather than
  depending on access to that private cache.
- The composer verifies every component checksum and checks the completed image's full CLI/Rust pair
  before the environment becomes ready.
- cli-none stops being blocked on "who vouches for a plain-Rust image" — a composed plain-Rust
  environment meets the same criteria; what remains is a policy decision (TRD §10 item 2).
- The report artifact format must carry the environment recipe block.
