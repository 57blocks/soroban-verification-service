# ADR-005: DTO ownership follows use; `packages/schema` retired

> **Status**: Accepted 2026-07-27
> **Scope**: Repository-wide DTO placement

## Context

`packages/schema` was a single package holding every wire shape in the system: HTTP request and
response DTOs for two services, the published S3 artifact shapes, the orchestrator↔builder Batch
contract, and the enum/validation kernel. Nearly every package depended on it.

That made it a false coupling point. `packages/config` pulled in the whole package to get one type
alias. `services/builder` — the component that must stay minimal — depended on it for four shapes
and transitively acquired everything else. Any change to a query-svc response shape touched a
package that the sandbox image installs. And it invited the wrong instinct for new shapes: "put it
in schema" was always the path of least resistance, so the package could only grow.

`orchestrator-svc` had already responded by maintaining its own structurally-identical copies of
nine DTO classes under `src/common/dto/`, guarded by a drift test — a local fix that traded one
problem for another.

## Decision

Delete `packages/schema`. Place each shape where it is used:

| Shape | Home | Why |
| --- | --- | --- |
| Used by more than one package | `packages/core` | The shared kernel: enums, guards, `parseDto`, `AtLeastOneOf`, `VerificationTarget`, the `SourceReference` family, `BuildRecipe`/`SubmittedSourceManifest`, the result/diagnostics model, `BatchJobParams`/`BuildArtifact`, `Aggregated*` |
| The published S3 result tree | `packages/storage-layout/src/shapes.ts` | Next to the key conventions and the publish/read functions that move them — this package *is* the result-tree contract |
| One service's own HTTP surface | that service's `modules/<feature>/*.dto.ts` | `verification-svc` owns every `Preflight*`/`Submit*`/`JobStatus*`/`UploadSource*` shape |

`orchestrator-svc`'s local copies and their drift test are deleted; it imports from `@scvs/core`.

**Two placements are load-bearing and must not be "simplified":**

1. **`BatchJobParams`/`BuildArtifact` go in `core`, not `packages/aws`** — even though `aws` is the
   Batch wrapper and looks like the natural owner. `services/builder` consumes both and deliberately
   has no `@scvs/aws` dependency ([ADR-002](ADR-002-builder-holds-no-business-credentials.md)).
   Routing them through the AWS package would drag the AWS SDK into the sandbox image.
2. **`Aggregated*` go in `core`, not `query-svc`** — even though query-svc is the only service that
   serves them. `clients/sdk` *produces* them and **query-svc depends on sdk**; owning them in
   query-svc would invert that edge into a cycle.

**Rule for new shapes:** put it in the service that owns the route. Promote it to `packages/core`
only once a second package genuinely needs it — not in anticipation.

## Consequences

**Easier**

- `packages/config`, `packages/db`, `packages/aws`, `packages/storage-layout`, and
  `services/builder` no longer depend on a package full of shapes they never use.
- The sandbox image's dependency surface shrank and is now checkable: builder's dependencies are
  `@nestjs/*`, `@scvs/core`, `reflect-metadata`, `rxjs`.
- No more duplicate-DTO drift test, because there are no duplicates.
- Where a shape belongs is now answerable from the shape's consumers, not by convention.

**Harder / constrained**

- ~~`packages/core` carries a `@nestjs/swagger` dependency, because shapes shared across packages also
  appear in HTTP responses. Every package that depends on core inherits it — including builder,
  which does not use it.~~ **Reversed 2026-08-06**: the schema is derived from the validation metadata
  now, so neither shared package depends on Nest and nothing inherits it — the sandbox image's
  dependency surface shrinks accordingly. See
  [ADR-004](ADR-004-class-validator-as-single-source.md), §"A shared DTO may have a non-server consumer".
- A consumer importing a barrel pulls everything that barrel re-exports, which for these two packages
  still includes `node:crypto` and `@scvs/aws`. Both expose subpath exports (`./enums`, `./validate`,
  `./registry`, `./aggregate`, `./result`; `./shapes`, `./keys`) whose graphs reach neither, and
  `clients/sdk` imports only those — `test/browser-graph-test.ts` is what stops a barrel import
  creeping back in.
- "Shared by ≥2 packages" is a judgement call at the margin, and the wrong call is a cycle. Check
  the direction of the existing dependency edge before promoting anything.
- Five shapes with zero references anywhere were dropped rather than moved: `PreflightRequest` and
  `SubmitRequest` (superseded by verification-svc's own request DTOs, which add `@AtLeastOneOf`),
  `ResultSource`/`ResultResponse` (stale — they describe a query-svc route that actually responds
  with `ByContractResultIndex`), and `ApiErrorResponse` (never wired into any `@ApiResponse`). They
  remain recoverable in git history at `8e590bb`.

## Validation

The migration ran in four verified phases. Throughout, the generated OpenAPI stayed **byte-for-byte
identical** — 24 schemas for verification-svc, 10 for query-svc — confirming that Swagger follows
the `@ApiProperty` decorators, not the package. Every moved class was compared field-by-field or
byte-for-byte against its new home before the source was deleted.

## Alternatives considered

- **Keep `packages/schema`, split it internally into subpath exports** — rejected: the dependency
  edge is per-package, so every consumer would still depend on the whole thing. It renames the
  problem.
- **Generate cross-service types from `openapi.json` with `openapi-typescript`** — investigated and
  rejected for this repo: there are no cross-service HTTP DTO consumers today (`clients/web` does
  not call query-svc, and `clients/sdk` reads S3 artifacts rather than query-svc's API). It would
  also invert the sdk→query-svc dependency into a bootstrap cycle. Worth revisiting if an external
  consumer appears.
- **Put everything in `packages/core` including per-service HTTP DTOs** — rejected: it recreates
  `packages/schema` under a new name.

## References

- `docs/features/_ARCHIVED/retire-schema-package/` — the full migration record: design, phase plan, and the
  discoveries that changed it mid-flight
- `AGENTS.md` — "Where a DTO belongs", the short version for day-to-day use
- Commit `eadeac0`
