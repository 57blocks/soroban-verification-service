# The builder↔orchestrator artifact contract, frozen

`recipe.json` is the only channel out of the build sandbox, and its two ends deploy separately — the
builder as a Batch job definition, the orchestrator as an ECS service. This directory is what makes a
change to that document's shape visible and versioned instead of a runtime surprise. It is checked by
`src/artifact-contract-test.ts`, which runs in `pnpm run test`.

## What is here

- **`build-artifact.v<MAJOR>.<MINOR>.json`** — a derived description of every class the contract
  reaches, every property each declares, and whether validation *rejects* a document that omits it
  (`absence_rejected`). Generated, never hand-edited:

  ```bash
  pnpm run generate:contract-snapshot
  ```

  A file here is **frozen once merged**. A diff to an existing version's snapshot, in a PR that did not
  introduce that version, is the one thing review must refuse — see
  [rules 24–25 of `docs/invariants.md`](../../../docs/invariants.md).

  There is no `v0.0` snapshot: nothing described the contract before this versioning scheme, so the
  pre-versioning shape is recorded only by its corpus below.

- **`corpus/v<version>/*.json`** — documents a builder at that version actually wrote. The current DTO
  must parse **every one of them, at every version, forever**: that is the permanent
  backward-compatibility guarantee, and this corpus is the assertion of it. Making a tolerated field
  required, or narrowing an `@IsIn`, fails here.

## Provenance of the corpus

`v0.0` is real: four documents pulled from `sv-dev-scratch`'s `staging/` prefix (2026-08-25 rebuilds),
with `build_log` and the stdout/stderr excerpts trimmed and the ECR registry host replaced by a
placeholder. `success-version-alignment.json` is one of those with only its
`diagnostics.reference_alignment` swapped for the release-tag shape the CLI retirement introduced — that is the
document whose arrival at an orchestrator still requiring `base_commit` wedged staging on 2026-09-01,
which is why it is frozen here rather than described.

`v1.0` is the `v0.0` set carrying `schema_version`, plus one document exercising
`source_canonicalisation`.

## Adding to the corpus

Add a document whenever a builder starts writing a shape no existing document covers — a new enum
member, a nested object that was never populated, an optional field's first real value. A corpus that
does not cover a shape cannot protect it.
