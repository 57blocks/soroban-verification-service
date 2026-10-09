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

- **`rebuild-error-codes.json`** — the other half of the same contract: every failure code the sandbox
  may write into `BuildArtifact.reason`, and the class `rebuildFailureReason` reads to decide
  retryability. Derived from `src/rebuild-error-code.ts`, never hand-edited:

  ```bash
  pnpm --filter @scvs/core run generate:error-code-snapshot
  ```

  Unlike the shape snapshots this one is **not** frozen per version — codes are added as the builder
  grows them. It exists so that adding, renaming or reclassifying one is a reviewable line in a diff
  rather than a silent change to whether a failure is retried. Checked by
  `src/rebuild-error-code-test.ts`.

## Provenance of the corpus

`v0.0` is real: four documents pulled from a deployment's scratch bucket, under its `staging/` prefix,
with `build_log` and the stdout/stderr excerpts trimmed and the ECR registry host and repository name
replaced by placeholders. `success-version-alignment.json` is one of those with only its
`diagnostics.reference_alignment` swapped for the release-tag shape the CLI retirement introduced — that is the
document whose arrival at an orchestrator still requiring `base_commit` wedged staging on 2026-09-01,
which is why it is frozen here rather than described.

`v1.0` is the `v0.0` set carrying `schema_version`, plus one document exercising
`source_canonicalisation`.

## Adding to the corpus

Add a document whenever a builder starts writing a shape no existing document covers — a new enum
member, a nested object that was never populated, an optional field's first real value. A corpus that
does not cover a shape cannot protect it.
