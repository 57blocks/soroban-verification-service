# Docker Compose

`docker-compose.yml` runs local Postgres 16 for development (matches the engine major version of the
shared dev RDS instance).
Bring it up with:

```bash
docker compose -f docker/docker-compose.yml up -d
```

Local dev connection fields (see the repository root `.env.example`, the single place they are
declared): `POSTGRES_HOST=localhost`, `POSTGRES_PORT=5433`, `POSTGRES_DB=scvs`,
`POSTGRES_USER=scvs`, `POSTGRES_PASSWORD=scvs_local_dev` — matching this compose file's service.

## `docker-compose.full-stack.yml` — the Full stack deployment mode

```bash
docker compose -f docker/docker-compose.full-stack.yml up
```

All three layers of TRD §4.1 on one host, from committed configuration — the "Full stack" row of
§4.6. `docker-compose.yml` stays what it was: **Postgres only, for local development**, which is a
dependency and not a deployment.

| | |
| :--- | :--- |
| Console | http://localhost:8080 |
| Verification API | http://localhost:5000 |
| Public Query API | http://localhost:5001 |
| Postgres | localhost:5433 |
| orchestrator-svc | no port — loopback health only, as in production |

**It brings up the stack; it does not make the build path local.** Rule 3 of `docs/invariants.md`
has `orchestrator-svc` always dispatching to AWS Batch, deliberately: a second rebuild path is a
second thing that can disagree with the reference implementation. Submission, status, publishing
and querying all work
here against local Postgres and a local result tree — but running an actual rebuild needs real
values in the repository-root `.env` (`SCVS_BATCH_JOB_QUEUE_ARN_ARM64`,
`SCVS_BATCH_JOB_QUEUE_ARN_AMD64`, `SCVS_BATCH_JOB_DEFINITION_ARN_ARM64`,
`SCVS_BATCH_JOB_DEFINITION_ARN_AMD64`,
`SCVS_JOB_STATE_CHANGE_QUEUE_URL`, `SCVS_STORAGE_BUCKET`). Without them that one container exits at
boot naming what is missing, which is the intended behaviour — except the two queue ARNs and the two
job-definition families, all four of which are `fail: first-use`: the container boots and the first
dispatch fails naming whichever architecture's coordinate the submission's build image needed.

**The legal documents are configuration, and the compose file supplies the placeholder ones.**
`verification-svc` serves its Terms of Service and Privacy Notice from the bundle
`SCVS_LEGAL_DOCUMENTS_SOURCE` names — a path or an `https:` URL, resolved against the workspace root, which
is `/app` inside the image — and **refuses to boot without one**, because a console taking submissions while
showing nobody any terms is the defect that requirement exists to remove. The compose file defaults it to
`config/legal-documents.example.json`, whose text is obvious placeholder and whose `effective_date` is null,
so acceptance is offered and not required. A self-hoster replaces it with their own; the reference
deployment's own bundle is `config/legal-documents.json`, which is what `dev` and `staging` use.

Three properties of this file are conformance, not style, and should survive edits:

- **`orchestrator-svc` is its own container.** The worker stays separated from the API in *every*
  shape, single-host Compose included — a compose file that collapses the worker into the API
  process is not a smaller deployment, it is a non-conformant one.
- **One `scvs_results` volume, written by `orchestrator-svc` and mounted `:ro` by `query-svc`.** A
  writer/reader mismatch is the single most likely misconfiguration in the deployment; here they
  cannot diverge, and the read layer cannot mutate a published result.
- **`migrate` is a `service_completed_successfully` dependency**, not a race. A service booting
  against an unmigrated database fails on its first query rather than at boot.

**Query-only is deliberately not here.** That mode must run with **no database** and `query-svc`
cannot yet — it takes Postgres for the Trusted Verifiers List, which is an open decision.
A "Query-only" service here that quietly required Postgres would claim a conformance row this repo
has not earned. Verifier-only is this file minus `query-svc` and `web`, and is left to the operator
until it has a test that proves it.
