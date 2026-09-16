# SCV-299: Content-Pin the TVL's `https:` Source with a Declared sha256 — Design

**Jira:** SCV-299 — "TVL 的 https: URL 源缺少 sha256 pin，仅有 scheme/host 校验"

## Problem

`scripts/seed-tvl.ts`'s `loadSource()` accepts `SCVS_TRUSTED_VERIFIERS_SOURCE` as either a local
file path or an `https:` URL. When it's a URL, the only validation applied is that the scheme is
`https:` (refusing `http:` and anything else) — nothing validates that the fetched *content* is
what was expected. If the hosting endpoint is compromised, a CDN cache is poisoned, or a
man-in-the-middle serves substituted content on an otherwise-valid TLS connection, this code has
no way to detect it: it will seed whatever bytes it received directly into the `trusted_verifiers`
table.

This is the same class of problem this codebase already solves elsewhere by pinning to an exact
value rather than trusting "the URL resolved and TLS succeeded" — e.g. every GitHub Actions
`uses:` reference in this repo is pinned to a 40-hex commit SHA, not a mutable tag or branch.

## Current state check

`config/env-manifest.yaml`'s `db-migrate.variables.SCVS_TRUSTED_VERIFIERS_SOURCE` currently
resolves to a local file path in every real environment (`config/trusted-verifiers.dev.json` for
dev, `config/trusted-verifiers.staging.json` for staging). The `https:` URL branch in
`loadSource()` exists in code but is not exercised by any current deployment. This means the fix
below has no risk of breaking an existing deployment — no environment's contract needs to change
for this to land safely.

## Design

**1. New environment variable: `SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256`**

Declared in `config/env-manifest.yaml` alongside `SCVS_TRUSTED_VERIFIERS_SOURCE` (same
`db-migrate.variables` block), following the same pattern (`tier: knob`, `inject: ecs-secrets`,
`required: no` — required-ness is enforced at the application level, conditional on whether an
`https:` source is configured, not by the manifest's own required/optional mechanism, matching
how the sibling variable's own conditional semantics — silent-fail default, environment-specific
override — are already handled in prose rather than in the manifest's type system).

**2. `seed-tvl.ts` behavior change**

In `loadSource()`, when the resolved source is an `https:` URL:
- Read `process.env.SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256`. If unset (or empty after trimming),
  throw immediately, before fetching — an `https:` source with no declared pin is refused
  outright, not just warned about. Local file-path sources are unaffected: a file path is already
  reviewable repository content or something the deploying environment's own configuration
  supplies directly, and pinning a *path* doesn't defend against anything a pin over fetched
  bytes does.
- After `fetch(url)` succeeds and the response is OK, read the response body as raw bytes
  (`ArrayBuffer`, not decoded text) and compute its sha256 with `node:crypto`'s `createHash`
  (the same primitive already used identically for byte-content hashing in
  `packages/storage-layout/src/publish.ts`). Compare the resulting hex digest against the
  configured `SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256`, case-insensitively (hex digests are
  conventionally lowercase but a config value typed by a human could be uppercase). On mismatch,
  throw with a message that includes both the expected and actual digest, clearly stating this is
  a content-pin mismatch (not a network/parse error) — so an operator immediately understands
  "the content changed since the pin was set" rather than confusing it with an unrelated fetch
  failure.
- Only after the digest check passes does the raw body get decoded into the `raw: string` this
  function already returns (via `TextDecoder`, replacing the current `response.text()` call —
  hashing must happen over the exact bytes that arrived on the wire, before any text decoding,
  so the pin covers literally what was transmitted).

This does NOT change behavior for the file-path branch of `loadSource()` at all.

**3. Error message content**

Two distinct failure messages, so an operator can tell these apart at a glance:
- Missing pin (URL configured, no sha256 declared): explain that an `https:` TVL source must
  declare `SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256`, matching the file's tone/style (this repo's
  existing error messages in this file explain *why*, not just *what*).
- Pin mismatch (fetched content's digest ≠ declared digest): state both digests and that this
  means the source's content no longer matches what was pinned — could be legitimate (the TVL
  document was updated and the pin wasn't) or could be tampering; either way, seeding must not
  proceed silently.

## Scope

**Files:**
- Modify: `soroban-verification-service/scripts/seed-tvl.ts` — only the `https:` branch of
  `loadSource()`.
- Modify: `soroban-verification-service/config/env-manifest.yaml` — add one new variable
  declaration next to the existing `SCVS_TRUSTED_VERIFIERS_SOURCE` entry.

No changes to `.github/workflows/db-migrate.yml` (it passes environment variables through
opaquely; it doesn't need to know this one exists) or to `config/trusted-verifiers.*.json` (file
sources are unaffected).

## Verification

`seed-tvl.ts` has no existing automated test suite of its own (it's a one-off CLI script, not a
package with `*.spec.ts` files — confirmed by absence of a test file alongside it). Verification
for this change is:
- TypeScript compiles / typechecks cleanly.
- Manual exercise: run the script locally against a small local HTTP server serving a valid TVL
  document, with a correct and then a deliberately wrong `SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256`,
  confirming the pass and fail paths both behave as designed. (No real AWS/database interaction
  needed for this — `loadSource()` can be exercised in isolation before `main()`'s DB-writing
  logic runs, or the whole script run against a disposable local Postgres if deeper verification
  is wanted — decided at plan-execution time.)

## Self-review

- **Placeholder scan:** none — every behavior (missing-pin throw, mismatch throw, hashing raw
  bytes before decoding, sha256 via `node:crypto`) is concretely specified.
- **Internal consistency:** the design doesn't touch the file-path branch at all, consistent with
  the problem statement (only the `https:` source lacks a way to verify content integrity — a
  file path is already inherently reviewable).
- **Scope check:** two files, one conceptually single change (declare a pin, enforce it) — no
  decomposition needed.
- **Ambiguity check:** "sha256 pin" could have meant hashing the parsed/re-serialized JSON
  instead of raw bytes; this is resolved explicitly in favor of raw bytes, matching how a
  git-style content pin should behave (byte-exact, not semantically-equivalent).
