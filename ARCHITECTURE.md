# Architecture

The code map: what this service is, how to run it, and how the pieces fit. Read this before making
a non-trivial change, not after.

## What this is

A Soroban (Stellar smart contract) source verification service: users submit a contract + source, the
service rebuilds it in a sandbox with no credentials and publishes whether the rebuilt Wasm matches
what's deployed on-chain. Built as a pnpm monorepo of independently-deployable NestJS services over a
small set of shared libraries.

## Commands

**A command's prefix tells you who runs it, with what credentials, and what a red run means.** The
whole table, one row per tool, is [`eng-tools/README.md`](eng-tools/README.md) — and
`pnpm run check:tool-index` fails the build when it drifts from the directory.

| prefix | who runs it | credentials | red means |
| :---- | :---- | :---- | :---- |
| `check:` | a workflow — `ci.yml` on every pull request unless the index says otherwise | **no AWS**, ever | the pull request is wrong. Green on `main`, always |
| `generate:` | you; CI then diffs the result | none | — |
| `deploy:` | `deploy*.yml`, and you with `--dry-run` | the deploy role | the deploy is refused |
| `release:` | `release.yml` | a registry token | the release is refused |
| `e2e:` | the E2E harness | a live environment | the fixture set is inconsistent |
| `report:` | `ci.yml`, on every pull request | none | — **it has no red**. It publishes what it found and exits 0 |
| `probe:` | you, from a runbook | **read-only** AWS | reality differs from the document — sometimes by design |
| `ops:` | you | **write** AWS | — it changed a live system |
| `dev:` `db:` `test:` | you, locally | local Postgres | — |

Two consequences worth internalising before you add a script. **A `check:` that no workflow runs is a
defect** — wire it, or give it the prefix that says who does. **A `check:` needs no AWS credentials**;
a tool that reads a live environment is a `probe:` whatever it asserts. Both are enforced by
`check:tool-index`.

The day-to-day set:

```bash
pnpm install                      # after clone
pnpm run generate:openapi         # both services' openapi.json, schemas derived from the DTOs'
                                  # validation metadata; fails on an unsound document
pnpm run generate:api-client      # generates verification-svc's openapi.json + clients/api-client's
                                  # react-query client from it — builds what it needs first
pnpm run build                    # every package/service, in dependency order
pnpm run typecheck                # see the caveat below — only clients/sdk implements it
pnpm run lint                     # clients/web only; other packages have no lint script
pnpm run test                     # every package's suite, `--continue` so one failure isn't the end
pnpm run check:env                # env-contract drift check — see below; runs in CI before the build
pnpm run generate:env-contract    # regenerates the observability descriptor check:env compares against
pnpm run generate:deploy-env      # regenerates config/deploy/<env>/<service>.json
```

The deployment toolchain [rule 23 of `docs/invariants.md`](docs/invariants.md) brought into this
repository. All five take `--env`; the two writers take `--dry-run`:

```bash
pnpm run deploy:check-descriptor -- --env dev
                                  # does /scvs/<env>/ci/descriptor carry every field the manifest
                                  # resolves from it? Read-only, and the acceptance test for a
                                  # descriptor change applied in soroban-aws-infrastructure
pnpm run deploy:sync-secrets -- --env dev --service query-svc --dry-run
                                  # what CI would write into scvs/<env>/<service>/config. WRITES
                                  # without --dry-run; idempotent, so a redeploy that changes
                                  # nothing creates no new secret version
pnpm run deploy:render-taskdef -- --env dev --service query-svc --image <ecr-ref>
                                  # the task definition CI would register: the RUNNING one with the
                                  # image and every variable replaced, everything else untouched
pnpm run deploy:check-taskdef -- --env dev --service builder <rendered.json>
                                  # rule 1's boundary (docs/invariants.md). Runs in CI before every
                                  # register, ECS and Batch alike, and fails closed — an input it
                                  # cannot parse is a failure, never a skip
```

`check:env` is the odd one out: plain Node over
[`eng-tools/check-env-manifest.mjs`](eng-tools/check-env-manifest.mjs), **not** a Turborepo task, and
needs neither a build nor a database. It cross-checks `config/env-manifest.yaml` against the variables
the code actually reads and against each service's `env.dto.ts`, and it fails on a variable that
exists in one of the three and not the others — including a sandbox that reads something its
`forbidden:` list denies it ([rule 10](docs/invariants.md)). Adding an
env var means touching three places; this is what makes forgetting one loud.

It also checks the `forbidden:` lists **themselves**, not just against code: an entry naming a
`retired:` variable fails, and a `forbidden_superset_of: <service>` relationship must actually hold.
Both were added after an incident where the composer's list denied a retired variable while permitting the
three that replaced it and `check:env` still exited 0 — a control that reads as held and is not.

The other four gate scripts (and `generate:api-client`) run through **Turborepo** — `turbo.json` holds
the task graph, pnpm still runs each script. Consequences worth knowing before you trust a green run:

- **The cache is real.** An unchanged package replays its previous log instead of rebuilding
  (`>>> FULL TURBO`). `turbo run build --force` bypasses it; `.turbo/` is the local cache.
- **`test` is deliberately uncached** — the suites read a local Postgres and an on-disk fixture tree
  Turborepo cannot hash, so a replayed pass would be a false green.
- **`typecheck` covers exactly one package so far**: `clients/sdk` defines it (`tsc --noEmit` over its
  `src/` and `test/`), because its build is `tsup` — esbuild transpiles without checking types, and its
  tests sit outside the bundled entry, so nothing else would look at them. For every other package the
  task still resolves to "build the dependencies and run nothing", and `tsc` inside that package's own
  `build` is its real type check. So a green run here means *the SDK is clean*, not that the workspace is.

`packages/*` and `clients/api-client`/`clients/sdk` resolve to `dist/` (and `clients/api-client/src/generated/`
is orval output) — both gitignored. Every consumer imports the compiled output, not the source, so **you
must run `generate:api-client` + `build` once after a fresh clone or after editing anything under
`packages/*`** — `pnpm --filter @scvs/<name> run build` for a single package (or
`turbo run build --filter=@scvs/<name>` to bring its dependencies along).

Per-service dev servers (each also has `build`/`start`, all via `tsc`/`node dist/main.js`):

```bash
pnpm run dev:verification-svc     # PORT default 5000
pnpm run dev:orchestrator-svc     # PORT default 5002 (health-check only, see below)
pnpm run dev:query-svc            # PORT default 5001
pnpm run dev:web                  # Vite, port 5173 (clients/web)
```

Tests are Jest (`ts-jest`, ESM) per-service, matching `test/**/*.spec.ts`:

```bash
pnpm --filter @scvs/orchestrator-svc run test                       # whole suite
cd services/orchestrator-svc && NODE_OPTIONS=--experimental-vm-modules npx jest test/foo.spec.ts   # single file
```

`clients/sdk`'s "test" is five standalone `tsx` scripts under `clients/sdk/test/`, not Jest:
`pnpm --filter @scvs/sdk run test` runs the client suite, the hosted-mode suite, the Registry-read
suite, and two browser gates — a module-graph walk and a bundle that is built for `--platform=browser`
and then **executed**. The tests live outside `src/` so the published bundle ships none of them, which
is also why this is the one package with a real `typecheck` script.

Those suites all share **one** Postgres, across services and across runs, and it is never reset.
[Rule 21 of `docs/invariants.md`](docs/invariants.md) is the rule that makes that
survivable: **a suite may read the whole table, but may only write or delete rows it created** —
track them with `@scvs/db/testing`'s `CreatedRows` and drop them in `afterAll`. Two things follow
that are easy to get wrong. A time-ranged cleanup ("everything since `beforeAll`") deletes a
concurrently running sibling suite's rows. And a production quota the harness is bound to exceed
belongs in `jest.setup.cjs` — that is what `SCVS_ABUSE_MAX_PER_WINDOW` and `SCVS_DRAIN_GRACE_MS` are
doing there. If a run starts or ends with a banner about database state, read it before you start
bisecting: it is telling you the failure may not be yours.

Local Postgres: `docker compose -f docker/docker-compose.yml up -d`, then the three migration
commands, all thin pnpm filters into `packages/db` — no wrapper scripts:

```bash
pnpm run db:migrate           # apply committed migrations (prisma migrate deploy)
pnpm run db:migrate:status     # what is pending — read-only; exits non-zero when migrations are pending
pnpm run db:migrate:new        # author one from your schema.prisma edits (migrate dev --create-only)
```

`db:migrate:new` **prompts for a migration name** and writes the SQL without applying it — review it,
then `pnpm run db:migrate`. It is what CI's drift check tells you to run when `schema.prisma` has
changes no committed migration produces. Two things to know: `pnpm run db:migrate:new -- --name x` does
**not** forward the flag (pnpm swallows it before the filtered command sees it), so for a
non-interactive run call it directly —
`pnpm --filter @scvs/db exec prisma migrate dev --create-only --name x` — and note that form creates an
*empty* migration when there is nothing to diff, so delete it if you did not mean it.

None of these is a Turborepo task, deliberately: turbo would cache them, and a replayed "migration
applied" is a false green for the same reason `test` is uncached.

Environment: **one `.env` at the repository root** (`cp .env.example .env`), read by every service,
the Prisma CLI, and the test suites. The loader walks up to `pnpm-workspace.yaml` rather than reading
`process.cwd()`, so it resolves the same file regardless of where a process starts
(`packages/config/src/load-env.ts`). A `services/<name>/.env` is only for values belonging to one
service and layers on top; nothing shared belongs in one. Precedence: exported env var →
`services/<name>/.env` → root `.env`.

## Architecture

### Workspace layout

```
packages/            Shared libraries (not independently deployed)
  core/                 The shared kernel: enums + guards, parseDto/validate helpers, and the
                        class-validator/class-transformer DTOs
                        used by more than one package — verification target, source refs +
                        build recipe/manifest, the result/diagnostics domain model, the
                        orchestrator↔builder Batch contract, and cross-verifier aggregation
  aws/                  Thin S3 / Batch / EventBridge / SQS client wrappers
  storage-layout/       S3 result-tree key conventions, the published result-tree shapes
                        (shapes.ts), + publish (write) / read (query) functions
  db/                   Prisma + Postgres: jobs / uploads / trusted-verifiers repos
  openapi/              Server-only: derives the OpenAPI schema from the DTOs' validation metadata.
                        The one shared package that imports @nestjs/swagger; no browser consumer
                        imports it
  config/               Env-var parsing (network, bucket names, verifier identity, storage backends)
services/             Independently deployable NestJS apps
  verification-svc/      Public HTTP: preflight, submit, job status (SSE), uploads, abuse-guard
  orchestrator-svc/       Internal only, no ALB: state machine, AWS Batch dispatch, publish pipeline
  builder/                Runs *inside* the AWS Batch job — the only unit executing untrusted
                          source; structurally has zero DB/AWS-credential access
  composer/               Also a Batch job, no HTTP listener — but the *trusted* one: it composes a
                          build environment from official components for a chain-derived
                          (cliver, rsver) pair, and no submitted input reaches it
  query-svc/              Public HTTP: cross-verifier aggregation over the Trusted Verifiers List —
                          a separate organisation's deployment, not part of any one verifier's own
                          (see the pipeline step below and the read-and-aggregate decision it
                          cites)
clients/
  web/                    Vite + React + TanStack Router submission/results console
  sdk/                    TS query/aggregation SDK (types from packages/core + storage-layout)
  api-client/             orval-generated react-query client, from verification-svc's OpenAPI
docker/                Dockerfiles (builder, service, web) + local dev Docker Compose (Postgres)
config/                Policy + trusted-verifiers-list JSON templates
```

### Per-service internal structure (uniform across all five services)

```
src/
  app.module.ts / main.ts (or entrypoint.ts for builder, no HTTP listener)
  common/                Cross-module shared code within that service (guards, filters, DTOs
                          used by more than one module)
  config/configuration.ts  The single @nestjs/config loader — every value a service's own
                          providers need is read here once and exposed via ConfigService;
                          nothing should call env-parsing helpers directly from business logic
  modules/<feature>/     One folder per feature: *.service.ts (@Injectable), *.module.ts,
                          *.controller.ts (HTTP-facing modules), *.dto.ts. Pure/stateless
                          helpers with no config or DI dependency stay as plain functions in a
                          `.util.ts` file rather than becoming a class.
```

Everything is real NestJS DI: constructor-inject `ConfigService` (or other providers), never read
`process.env` or call a config-package helper from inside a plain function/service body. If a file
needs config, it's a provider that gets it from its own module's DI graph. The documented exceptions
are reads that run before that graph exists — decorator arguments, which are evaluated at
class-definition time, and `main.ts`'s bootstrap logger/CORS setup — and each such site carries a
comment saying why.

`@scvs/db` follows the same rule: `DbModule.forRootAsync` provides the `PrismaClient` and every
repository (`JobsRepository`, `UploadsRepository`, `TrustedVerifiersRepository`,
`AbuseControlRepository`, `JobEventsService`), so a service injects a repository rather than importing
a function over a module-level client. Callers with no Nest container — `scripts/seed-tvl.ts`, the
Jest suites — build the same classes explicitly:
`new JobsRepository(createPrismaClient(readDbEnv()))`.

### `clients/web` internal structure

Feature-first, one vertical slice per page — `features/landing/` and `features/verification/` — each
owning its own `components/`, `hooks/`, `routes/`, `types/`, `utils/`, and copy, and exporting only
through its `index.ts`. `src/app/` assembles the route tree from what the features export;
`src/lib`, `src/hooks`, `src/config` hold only what a second feature needed. Components render,
hooks decide.

The UI kit is **shadcn/ui** (primitives copied into `src/components/ui`, restyled to the design
tokens) over **Tailwind utilities written inline in the JSX** — there are no feature stylesheets,
and every colour, radius, shadow, and animation is a token in `tailwind.config.js`. Forms are
**react-hook-form**; toasts are **sonner**. Full contract in
[`clients/web/README.md`](clients/web/README.md#structure).

### The verification pipeline

Which service does what, in order: **verification-svc** accepts a submission and persists a `queued`
job; **orchestrator-svc** polls for queued jobs, resolves the deployed Wasm's on-chain identity, and
dispatches an AWS Batch job (always — there is no local/in-process fallback); **builder** runs
inside that Batch job as the only unit executing untrusted source, and holds no database access or
business AWS credentials; orchestrator-svc's consumer then computes the verdict itself from
freshly-fetched bytes and writes the published documents via `@scvs/storage-layout`; **query-svc**,
a separate deployment, aggregates across verifiers over the public read surface and has no
privileged path into any verifier's own storage.

The full behavioral contract — chain-record classes, mechanism selection, the sandbox's two stages,
byte-equivalence rules, the published result shape, failure taxonomy — is
[`docs/specs/verification.md`](docs/specs/verification.md),
[`docs/specs/build-environments.md`](docs/specs/build-environments.md), and
[`docs/specs/published-results.md`](docs/specs/published-results.md), each claim backed by a test.

### Where a DTO belongs

`packages/schema` is **gone** — see [rule 7 of `docs/invariants.md`](docs/invariants.md) for the
decision. One class is still one thing — validation rule + TS type + Swagger schema — but ownership
now follows use:

- **Used by more than one package → `packages/core`.** Enums/guards, `parseDto`/`AtLeastOneOf`, and the
  shared DTOs: `VerificationTarget`, the `SourceReference` family + `BuildRecipe`/`SubmittedSourceManifest`,
  the result/diagnostics model (`SandboxDiagnostics`, `VerificationResultSummary`, `ResultPointer`, `Wasm*`),
  the Batch contract (`BatchJobParams`, `MaterialiseJobParams`, `BuildArtifact` — **three**
  documents; the materialiser's params were missing from this list until 2026-08-12), and `Aggregated*`.
- **The published S3 result tree → `packages/storage-layout/src/shapes.ts`**, next to the key conventions
  and the publish/read functions that move them.
- **One service's own HTTP surface → that service**, in `modules/<feature>/*.dto.ts`. verification-svc owns
  every `Preflight*`/`Submit*`/`JobStatus*`/`UploadSource*` shape; query-svc's routes respond with core's
  `Aggregated*` and storage-layout's index shapes.

Two placements are load-bearing and must not be "simplified":

- `BatchJobParams`/`BuildArtifact` live in **core, not `packages/aws`**, because `services/builder` consumes
  them and deliberately has no `@scvs/aws` dependency (it holds no AWS credentials and uploads via a plain
  `fetch` PUT to a presigned URL — see `services/builder/src/modules/builder/upload.ts`). Routing them
  through the AWS package would drag the AWS SDK into the sandbox image.
- `Aggregated*` live in **core, not query-svc**, because `clients/sdk` produces them and **query-svc depends
  on sdk** — owning them in query-svc would invert that edge into a cycle.

When adding a shape, put it in the service that owns the route; promote it to `packages/core` only once a
second package genuinely needs it. the schema is derived from the validators by `@scvs/openapi`, not declared — moving a
DTO between packages does not change the generated `openapi.json`.

### Config and secrets

**[`config/env-manifest.yaml`](config/env-manifest.yaml) declares every environment variable** — its
type, whether it is required, what a missing value costs, which service reads it, and who supplies
it. Adding or removing one means editing the manifest, the service's `env.dto.ts`, and the code, in
the same PR; `pnpm run check:env` fails otherwise ([rule 10](docs/invariants.md)).

Every service validates its environment at boot against a class-validator DTO
(`services/<name>/src/config/env.dto.ts`, over `@scvs/config`'s shared base), reporting **all**
problems at once before any provider is constructed. `orchestrator-svc` requires real AWS access
even for local development — it fails fast at startup if Batch/queue/bucket variables are missing.

Infrastructure ownership, the configuration/credentials secret split, and the deployment pipeline's
own contract are [rules 8, 10, 22–23 of `docs/invariants.md`](docs/invariants.md), detailed further
in [`docs/specs/configuration.md`](docs/specs/configuration.md). A change to a service's
configuration surface belongs in that spec, in the same PR.
