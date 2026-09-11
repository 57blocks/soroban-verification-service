# Soroban Contract Verification Service

A source verification service for Soroban (Stellar smart contract) deployments: a submitter posts a
contract and its source, the service rebuilds it in an isolated sandbox with no credentials, and
publishes whether the rebuilt Wasm matches what's actually deployed on-chain.

The verification frontend lives inside this workspace:

`clients/web`

New here, or an agent working in this repo? Start at [`AGENTS.md`](AGENTS.md) — a one-page signpost
to everything below.

## Workspace Layout

```text
packages/             Shared libraries, not independently deployed
  core/                 ★ the shared kernel: enums + guards, parseDto/validation helpers, and every
                        class-validator DTO used by more than one package. See docs/invariants.md
                        rules 4, 5, 7.
  aws/                  Thin AWS client wrappers: S3, presigned URLs, Batch, EventBridge
  storage-layout/       S3 result layout: key conventions, published result-tree shapes, publish, read
  db/                   Prisma + Postgres: jobs/uploads/trusted-verifiers/abuse-control repos
  db-query/             query-svc's own Prisma schema and repos (trusted verifiers, aggregation),
                        separate from db/ so the query layer owns its database
  openapi/              Derives OpenAPI schemas from the class-validator metadata the DTOs already
                        carry, so a shared package needs no Nest dependency to be documented
  config/               Env parsing (network, bucket names, verifier identity), shared constants
services/             Independently deployable units, all NestJS
  verification-svc/     Preflight, submit, job status, abuse-guard (resident)
  orchestrator-svc/     State machine, build dispatch, provenance tracking, Wasm comparison,
                        artifact assembly, publish, Arweave archive — one resident deployable
  builder/              ★ Runs inside AWS Batch — the only unit that executes untrusted source, with
                        zero DB or credential dependency. Standalone context, no HTTP
  composer/             ★ Also an AWS Batch job, also no DB or credentials — composes a build image
                        from official components for a chain-derived (cliver, rsver) pair
                        (docs/invariants.md rules 16, 18). One-shot, no HTTP
  query-svc/            Public multi-verifier aggregation over the Registry API of every Trusted
                        Verifiers List member, including one this operator also runs
clients/              User/downstream-facing
  sdk/                  TypeScript query/aggregation SDK
  api-client/           @scvs/verify-api-client — the react-query submission client orval generates
                        from verification-svc's OpenAPI spec. Generated, gitignored
  web/                  Vite + React + TanStack Router submission and result console
docker/               builder/composer/service/web Dockerfiles, local dev Docker Compose (Postgres),
                      and docker-compose.full-stack.yml — all three layers on one host
config/               Policy, trusted verifier list, env templates
docs/                 Glossary, architecture overview, invariants, feature records, runbooks —
                      start at docs/README.md
test/                 Integration/e2e, differential, performance suites and fixture data
scripts/              seed-tvl.ts, plus ci/ helper scripts
```

- Verification API and queue-backed orchestrator-svc.
- SEP-58 metadata parser and submitted-source manifest flow.
- Public `source_uri` archive and private uploaded tarball source modes.
- Digest-pinned SDF trusted build image policy.
- Sandbox runner with resource limits and controlled egress.
- Result publishing (in orchestrator-svc): hash-keyed status objects and full artifacts (docs/invariants.md rule 14).
- Public Query API.
- TypeScript SDK.
- Docker Compose, schemas, tests, and docs.
## Quick Start From Zero

### 1. Install prerequisites

You need:

- Node.js 20+ and pnpm (`corepack enable` or `npm install -g pnpm`) — this is a pnpm workspace,
  not npm/yarn
- Git
- Docker Desktop or Docker Engine, running locally — only needed for the local Postgres
  container (`docker/docker-compose.yml`). The actual contract build/verify step always runs as
  a real AWS Batch job (`services/builder`'s Docker image, running in AWS); nothing runs
  `docker run` on your machine anymore.
- A standard, stable Stellar CLI release (see step 2)
- Your own AWS account, with a Batch job queue/job definition, an S3 bucket, and an SQS queue set up
  for step 5 (see [`docs/infrastructure-requirements.md`](docs/infrastructure-requirements.md) for
  what `orchestrator-svc` expects), and credentials with access to all three. `orchestrator-svc` always
  dispatches builds to real AWS Batch, so this is required even for local dev; there is no
  local-only fallback mode.

Check Docker first:

```bash
docker ps
```

### 2. Install the Stellar CLI

`verification-svc`'s `preflight/chain-reader.ts` and `orchestrator-svc`'s
`verification-pipeline/chain-reader.service.ts` both run the Stellar CLI locally, but only for
read-only on-chain lookups — `stellar contract fetch` and `stellar contract info meta` — which have
been stable, released commands for a long time. A standard install is enough:

```bash
stellar --version
```

Export the binary path if it isn't already on `PATH`:

```bash
export STELLAR_CLI_PATH="$(command -v stellar)"
```

You do **not** need to build Stellar CLI from source — nothing in this repo does any more. It used
to: the images needed `stellar contract verify` and `contract archive` from
`stellar/stellar-cli#2585`/`#2586`, so CI merged three pinned commits and compiled them. Upstream
closed `#2586` as won't-ship, the mechanisms that used both subcommands are retired, and what the
services actually spawn — `contract fetch` and `contract info meta` — is in every release. So
`docker/stellar-cli.pin` is now a plain version pin against an official release, and
`scripts/ci/fetch-or-build-stellar-cli.sh` downloads it (digest-verified) rather than building it.

### 3. Install this workspace

```bash
git clone <this-repo-url>
cd soroban-verification-service
pnpm install
```

### 4. Build the shared workspace packages once

`packages/*` (`core`/`db`/`config`/`aws`/`storage-layout`) and `clients/api-client`/`clients/sdk`
all resolve to `dist/` via their `package.json` `main`/`exports` fields, and
`clients/api-client/src/generated/` is generated by orval from `verification-svc`'s OpenAPI spec.
Both `dist/` and `generated/` are gitignored, so a fresh clone starts empty. The `dev:*` scripts
below run each service's TypeScript source directly via `tsx watch` — they do **not** compile
these workspace dependencies for you — so generate and build them once first, or every service
will fail to start with a "Cannot find module '@scvs/db'"-style error:

```bash
# Generates services/verification-svc/openapi.json, then the react-query API client clients/web
# imports from @scvs/verify-api-client.
pnpm run generate:api-client

# Builds every workspace package (prisma generate + tsc for packages/db, tsc for the rest), in
# dependency order.
pnpm run build
```

Whenever you change code inside `packages/*`, rebuild it (`pnpm --filter @scvs/<name> run build`,
or just re-run `pnpm run build`) — every consumer imports the compiled `dist/`, not the source.

### 5. Start Postgres, then the API + orchestrator-svc

Jobs, uploads, and trusted-verifier state live in Postgres (`packages/db`, Prisma). Bring up the
bundled container and apply migrations:

```bash
docker compose -f docker/docker-compose.yml up -d
cp packages/db/.env.example packages/db/.env
pnpm run db:migrate
```

Configure the connection **once**, in a `.env` at the repository root — `cp .env.example .env`, whose
defaults already match the Compose container's port (`5433`) and credentials. Every service, the
Prisma CLI, and the test suites read that one file; a `services/<name>/.env` layers on top of it and
is only for values belonging to a single service. Either the discrete `POSTGRES_*` vars or a plain
`DATABASE_URL` overriding all five — see `packages/db/src/env.ts`.

Default ports come from each service's `configuration.ts` — **verification-svc 5000, query-svc 5001,
orchestrator-svc 5002** — so `PORT` need not be set. Override it only if something else occupies one,
and update the URLs below to match.

```bash
STELLAR_CLI_PATH="$STELLAR_CLI_PATH" SCVS_CLI_TIMEOUT_MS=600000 \
pnpm run dev:verification-svc

AWS_REGION=<your-region> AWS_PROFILE=<your-aws-profile> \
SCVS_BATCH_JOB_QUEUE_ARN_ARM64=<your-arm64-queue-arn> SCVS_BATCH_JOB_QUEUE_ARN_AMD64=<your-amd64-queue-arn> \
SCVS_BATCH_JOB_DEFINITION_ARN_ARM64=<your-arm64-job-definition> SCVS_BATCH_JOB_DEFINITION_ARN_AMD64=<your-amd64-job-definition> \
SCVS_JOB_STATE_CHANGE_QUEUE_URL=<your-sqs-queue-url> SCVS_STORAGE_BUCKET=<your-s3-bucket> \
SCVS_CLI_TIMEOUT_MS=600000 \
SCVS_RESULT_ROOT=./artifacts/public SCVS_PUBLIC_RESULT_ROOT=http://localhost:5001/public \
pnpm run dev:orchestrator-svc

pnpm run dev:query-svc
```

`orchestrator-svc` always submits a real AWS Batch job, starting in "verify" mode; the terminal
outcome arrives asynchronously over SQS, after which it compares the rebuilt Wasm hash and publishes.
It has no ALB and takes no inbound business traffic — port 5002 backs a container health check only.

**There is no local-only build path.** Both Batch queue ARNs, both job definition ARNs,
`SCVS_JOB_STATE_CHANGE_QUEUE_URL`, `SCVS_STORAGE_BUCKET` and working AWS credentials are required
even for local dev; `orchestrator-svc` fails fast at startup without the SQS queue. See
[`docs/infrastructure-requirements.md`](docs/infrastructure-requirements.md) for what each resource
needs to be able to do, so you can provision your own equivalents.

There are **two** Batch queues because each compute environment is single-architecture (arm:
Graviton; x86: `c6i/c7i`) and a submission's build image is pulled and executed on that host, so
dispatch reads which architectures the image publishes and picks the queue that can run it.

For the direct Docker rebuild path used by manual-evidence contracts, `services/builder` applies
`SCVS_DOCKER_CPUS=2`, `SCVS_DOCKER_MEMORY=2g`, `SCVS_DOCKER_PIDS_LIMIT=512`. These are read inside
the Batch container (`services/builder/src/config/configuration.ts`), not by `orchestrator-svc`, so
they are configured on the Batch job definition CI registers — see
`.github/workflows/deploy-builder.yml`.

The final rebuild runs with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--network none`,
`--read-only`, a non-root `--user`, a read-only `/source` mount and a writable `/out` mount. Before
it, the runner stages a temporary copy of the source and runs `cargo vendor --locked` in the same
digest-pinned image, mounting source read-only and writing only to a dedicated `/vendor` mount.
Dependency prefetch rejects URLs targeting private, local, or metadata hosts; add legitimate public
hosts with `SCVS_PREFETCH_ALLOWED_HOSTS`. `stellar contract build` then runs with `--locked`,
`CARGO_NET_OFFLINE=true`, tmpfs-backed `/tmp` and `/var/tmp`, a Cargo config pointing crates.io at
the vendored directory, and no container network.

On a terminal job the API publishes this verifier's static result root — by default
`${SCVS_ARTIFACT_DIR}/public`. `SCVS_RESULT_ROOT` chooses the output directory and
`SCVS_PUBLIC_RESULT_ROOT` the URL consumers should use. Storage adapters:
`SCVS_PUBLISHER_STORAGE=filesystem` (local) or `r2` (Cloudflare R2, over its S3-compatible API);
`s3` and `gcs` are reserved.

`services/query-svc` reads that storage back through `packages/storage-layout`'s key conventions and
re-exposes it as JSON, not as a raw static file tree — there is no `/.well-known/verifier-manifest.json`
or `/policy.json` route today. The implemented routes are:

```text
GET http://localhost:5001/api/query/v1/wasms/{wasm_hash}                 # aggregated, one entry per verifier
GET http://localhost:5001/api/query/v1/contracts/{network}/{contract_id} # address resolved per request, then aggregated
GET http://localhost:5001/api/query/v1/wasms                             # aggregated bulk load (our aggregation order)
GET http://localhost:5001/api/query/v1/verifiers                         # Trusted Verifiers List
GET http://localhost:5001/api/query/v1/health                            # liveness and readiness
GET http://localhost:5001/api/query/v1/docs                              # Swagger UI (verification-svc's is /api/verification/v1/docs, on :5000)

GET http://localhost:5000/api/verification/v1/wasms                      # this verifier's OWN bulk load (its publication order)
GET http://localhost:5000/api/verification/v1/wasms/{wasm_hash}.json     # this verifier's own status object; 202 while a job is in flight
```

Paths carry a per-service mount prefix (`/api/query`, `/api/verification`) so both services share one
host; the Results SEP fixes paths relative to a base URL, not hosts. The `.json` suffix marks a
document a static origin can serve as-is, which is why only the per-hash status object carries one —
the `.json` spellings of the other three answer as deprecated aliases until 2026-12-01.
### 6. Start the verify web app

```bash
VITE_VERIFY_API_URL=http://localhost:5000 pnpm run dev:web
```

`clients/web` is a Vite + React + TanStack Router app (not Next.js); `dev:web` passes
`--port 5173` explicitly. Open:

- `http://localhost:5173/verify`
- `http://localhost:5173/verify`
- `http://localhost:5173/verify/jobs/{job_id}`

The web app talks to the Verification API through `VITE_VERIFY_API_URL`.

It targets:

- `POST /v1/preflight`
- `POST /v1/verifications`
- `POST /v1/uploads/source`
- `GET /v1/verifications/{job_id}`
- `GET /v1/verifications/{job_id}/events` (SSE — job status stream)

Cross-verifier query results (`GET /api/query/v1/contracts/{network}/{contract_id}` and
`GET /api/query/v1/wasms/{wasm_hash}`) are served by `services/query-svc` instead.

The two bulk-load routes share a request shape (`order`, `limit`, `cursor` as `{timestamp}-{wasm_hash}`)
and page over **different clocks**: verification-svc's `/api/verification/v1/wasms` over this verifier's
own publication update time, query-svc's `/api/query/v1/wasms` over when *we* last changed our
aggregate. Neither answers "when
was this verified?" — that is `processed_at` inside the entry. Consumers upsert by `wasm_hash`;
re-delivery is expected, not duplication.

## CI/CD prerequisites (GitHub Actions)

Nothing above needs this — local development talks to AWS with your own credentials. This section is
for a **fork or a fresh clone that must run the deploy workflows**, which authenticate to AWS by OIDC
and therefore need two values GitHub cannot derive: they are the irreducible bootstrap, the values CI
needs *before* it can read anything else.

Everything else — cluster name, ECR repositories, Batch families, hosts — is read at run time from the
per-environment CI descriptor in SSM, so only these two are configured by hand.

### 1. Repository secret — the AWS account ID

```bash
gh secret set AWS_ACCOUNT_ID --body "<your-12-digit-account-id>"
```

Read by the deploy-role fallback in `deploy.yml`, `db-migrate.yml`, `deploy-builder.yml`, and
`deploy-composer.yml`. It is set at the **repository** level, not per environment, because the
account-wide workflows (deploy-builder, deploy-composer) pin `environment: dev` yet register job
definitions for both environments.

Two things worth knowing before you copy this pattern elsewhere. An account ID is an identifier, not a
credential — it is stored as a secret here only so it stays out of the tree, and the cost is that
Actions redacts it from logs, so ECR URLs and descriptor JSON print with `***` in the middle. And
inside a workflow it must be passed as an **operand**, never interpolated into a quoted string:

```yaml
# ✗ nested ${{ }} inside a string literal is never expanded — yields a literal, broken ARN
|| 'arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/scvs-github-actions-builder-deploy'

# ✓ evaluated by the expression engine
|| format('arn:aws:iam::{0}:role/scvs-github-actions-builder-deploy', secrets.AWS_ACCOUNT_ID)
```

### 2. Per-environment variable — the OIDC deploy role

One `DEPLOY_ROLE_ARN` in each GitHub Environment (`dev`, `staging`), which is what the fallback above
exists to cover. When it is set — as it is in this repository — it wins and the fallback never
evaluates:

```bash
gh variable set DEPLOY_ROLE_ARN --env dev     --body "arn:aws:iam::<account>:role/<dev-deploy-role>"
gh variable set DEPLOY_ROLE_ARN --env staging --body "arn:aws:iam::<account>:role/<staging-deploy-role>"
```

The roles themselves are Terraform's, in `soroban-aws-infrastructure` — this repository never creates
AWS resources ([rule 8 of `docs/invariants.md`](docs/invariants.md)). Until
`terragrunt apply` has run for an environment, its CI descriptor does not exist and deploys **skip
with a notice rather than failing** — the honest signal that the infrastructure half has not landed.

After changing any workflow, run the gate that rejects what GitHub would reject:

```bash
pnpm run check:workflows
```

Every command this repository has is indexed in [`eng-tools/README.md`](eng-tools/README.md), one row
per tool. A command's prefix says who runs it and with what credentials — `check:` on every pull
request with none, `probe:` from a runbook with read-only AWS, `ops:` when it writes to a live
environment.

## Status

- `services/verification-svc` — preflight/submit/job-status/upload endpoints, manifest validation,
  digest-pinned image policy, idempotency keys. Also serves this verifier's own published-results
  stream, `GET /api/verification/v1/wasms`.
- `services/orchestrator-svc` — TRD §4.3's `queued -> preparing -> building -> comparing ->
  publishing -> published` state machine (plus `publish_pending`, `evaluated` for a dry run, and
  `failed`), claiming every transition with a conditional write; resolves private uploads before
  handing off to the builder, which never touches the database. Also performs the Wasm hash
  comparison (`publish/wasm-compare.util.ts`) on the trusted resident host, never inside the
  sandbox, then assembles and publishes the result.
- `services/builder` — `fetch-source.ts` materializes `source_uri`/git/tarball archives, verifies the
  submitted SHA-256, and rejects unsafe tarball paths and links. `run-cli.ts` has one path since the
  `stellar contract verify` mechanism was retired: `cargo vendor` prefetch under an egress
  allowlist, then a no-network `docker run` into the digest-pinned image. It reaches no verdict — the
  comparison is orchestrator-svc's.
- `services/composer` — the second Batch job. Composes and pushes a build image for a cli-legacy
  target's chain-recorded `(cliver, rsver)`, and PUTs a receipt `EnvironmentOutcomeService` verifies.
- `services/query-svc` — not part of this verifier's deployment. Aggregates across the Trusted
  Verifiers List, reading every member over the public Registry API.
- `clients/web` — the `/verify` landing page, preflight, submit, job polling over SSE, the build log,
  the Wasm-comparison diagnostics, source access, direct job pages, browser-local recent jobs, and the
  flag-gated `/query` aggregator.

`test/integration/` is the black-box `@scvs/e2e-tests` suite — 119 cases, run against a real
deployment through its public surfaces only, and a no-op unless `SCVS_E2E` is set (see
`test/integration/README.md`). The SDK carries its own runner:

```bash
pnpm --filter soroban-verification-client run test
```

which exercises aggregation, registry reads, and the two browser-bundleability checks.

To rebuild the static result root from results already in Postgres:

```bash
SCVS_RESULT_ROOT=./artifacts/m2-public \
SCVS_PUBLIC_RESULT_ROOT=http://localhost:5001 \
pnpm --filter @scvs/orchestrator-svc run publish-once
```

Useful after deleting `SCVS_RESULT_ROOT`, changing the public CDN root, or recovering from a failed
publish. It scans the results, rewrites the artifacts, hash-keyed status objects, manifest and
policy, then stores the artifact metadata back in Postgres.

For local end-to-end verification, run the API with `STELLAR_CLI_PATH` and a long enough
`SCVS_CLI_TIMEOUT_MS`, then run the web app with `VITE_VERIFY_API_URL=http://localhost:5000`.

For real testnet verification, submit a testnet contract ID or Wasm hash with a manifest containing:

- `source_sha256` — SHA-256 of the exact source archive bytes
- `source_uri` — verifier-reachable `https://...`, `file://...`, or an absolute local path (dev only)
- `bldarg` (SEP-58 v0.6.0) — optional ordered leading entry-point arguments, e.g. `cargo build` for a
  plain Rust image; defaults to `contract build` when absent
- `bldopt` — the build options Stellar CLI embedded, e.g. `--locked`, `--manifest-path=...`,
  `--package=...`, `--optimize`
- `is_public` — whether the source bytes may be published. Absent means `false` (TRD §6.1)

**Not `bldimg`.** The build environment is derived from the deployed Wasm, never from the submission:
a `bldimg` in the chain-injected section makes the target cli-58 and is used as-is once
`evaluateBuildImage` accepts it; a target recording none is cli-legacy, and `services/composer`
composes an image from the recorded `(cliver, rsver)` pair (docs/invariants.md rules 16, 18). The field survives on
`SubmittedSourceManifest` for older clients and `resolveEnvironmentIdentity` never consults it.

What the submitter supplies is the source and how it was built. The rebuilt Wasm hash is compared
against the one fetched from chain either way.

### Real testnet example

- `contract_id`: `CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG`
- `source_uri`: a downloadable archive, **not** a GitHub HTML page — the verifier must fetch the exact
  archive bytes:

```text
https://raw.githubusercontent.com/jia57b/soroban-contract/main/ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533.tar.gz
```

The same values are captured as a reusable manual e2e fixture under `test/e2e/testnet/`.
