# SCVS services — AWS infrastructure requirements

> **Audience**: someone who wants to self-host `soroban-verification-service` (SCVS).
> This document describes each service's **functional infrastructure dependencies** (compute,
> network, storage, database, queueing, secrets management, and so on). It does not prescribe an
> orchestration tool, a topology, or an organizational scheme — how you build it, whether you share
> resources, and which IaC tool you use are your own decisions. **One caveat**: some dependencies are
> already hardcoded to a specific vendor's implementation at the application-code level, so not every
> category is freely swappable — see the "coupling" column in each table in §2 and the explanation in
> §5.

## 1. The services

SCVS is made up of four HTTP/background services, plus two batch-compute workloads they dispatch into:

- **web** — the user-facing frontend / reverse-proxy layer.
- **verification-svc** — accepts contract-verification submissions and dispatches build jobs.
- **orchestrator-svc** — a background orchestration service: consumes build-job outcomes and
  publishes the final verification result.
- **query-svc** — a read-only query service, for retrieving already-completed verification results.
- **builder** — runs inside the batch job `orchestrator-svc` dispatches; the only place submitted
  source is actually executed. Not a service you deploy standalone — it needs its own, separately
  provisioned batch-compute environment and IAM posture. See §2.5.
- **composer** — a second, separate batch-compute workload, needed only if you also serve cli-legacy
  targets (build environments composed from official components rather than a chain-recorded image).
  See §2.6.

`verification-svc` and `orchestrator-svc` are a producer/consumer pair: the former accepts a request
and dispatches a build job; the latter consumes that job's outcome and publishes it. Both need access
to the same data and the same async job-execution environment — they are not separable in practice.
**`builder` and `composer` are not part of that pair.** Each needs its own IAM role and its own
batch-compute environment — see §2.5/§2.6.

## 2. Infrastructure each service needs

### 2.1 `web`

| Type | Requirement | Coupling |
|---|---|---|
| Compute | An environment (container/process) that can run one HTTP service | No vendor dependency |
| External network | If publicly reachable: a load balancer or reverse proxy + TLS certificate + DNS | No vendor dependency |
| Database | None | — |
| Object storage | None | — |
| Async job-execution environment | None | — |
| Secrets management | None (or a small amount of non-sensitive configuration only) | — |

Depends on no database, object storage, async job-execution environment, or message queue — the
lightest of the four, easiest to run standalone, and the only one of the four with no vendor-lock-in
concern at all.

### 2.2 `query-svc`

| Type | Requirement | Coupling |
|---|---|---|
| Compute | An environment (container/process) that can run one HTTP service | No vendor dependency |
| External network | If publicly reachable: a load balancer or reverse proxy + TLS certificate + DNS | No vendor dependency |
| Database | One relational database (PostgreSQL), holding published verification-result data | **Freely swappable**: the code speaks a standard Postgres connection string, with no dependency on any cloud vendor's proprietary database features — any self-hosted or managed Postgres works |
| Object storage | None (unless result detail is also stored in object storage, depending on the data model) | — |
| Async job-execution environment | None | — |
| Secrets management | Database connection credentials | **Freely swappable**: the code only reads configuration from environment variables and calls no cloud vendor's secrets-management service |

A pure read service, dependent on one database only, and not part of the verification pipeline
itself.

### 2.3 `verification-svc`

| Type | Requirement | Coupling |
|---|---|---|
| Compute | An environment (container/process) that can run one HTTP service | No vendor dependency |
| External network | Needs public reachability: a load balancer or reverse proxy + TLS certificate + DNS | No vendor dependency |
| Database | One relational database, recording submitted verification jobs and their status | **Freely swappable** (as above) |
| Object storage | At least one location: staging submitted contract source/build artifacts (short-lived retention is fine), and/or where published results are stored | **Partially locked**: a storage abstraction layer exists, and the local filesystem is a genuinely usable non-object-storage path — but the object-storage implementation itself goes through a specific cloud vendor's object-storage SDK and its protocol-compatibility mode, and several call sites invoke that SDK directly, bypassing the abstraction. Not fully pluggable |
| Async job-execution environment | Needs the ability to **submit** build jobs — it does not execute builds itself, only dispatches them | **Locked**: the dispatch logic calls a specific cloud vendor's batch-service SDK directly; there is no swappable dispatch interface |
| Secrets management | Database connection credentials | **Freely swappable** (as above) |

### 2.4 `orchestrator-svc`

| Type | Requirement | Coupling |
|---|---|---|
| Compute | An environment (container/process) that can run one long-lived background process (no need for inbound network exposure) | No vendor dependency |
| External network | None | — |
| Database | The same database `verification-svc` uses (the same data) | **Freely swappable** (as above) |
| Object storage | Same as `verification-svc`: reads and writes both the staging area and the results area | **Partially locked** (as above) |
| Async job-execution environment | Needs the full job-execution capability: the compute environment that actually runs build jobs, plus a message queue to consume job-status-change events | **Locked**: both job dispatch and result consumption call a specific cloud vendor's batch service and message-queue SDKs directly. Boot fails immediately if the corresponding service is missing — there is no abstraction layer, and no other vendor's implementation exists |
| Secrets management | Database connection credentials; if optional features like external archiving/on-chain anchoring are enabled, their corresponding secrets too | **Freely swappable** (as above) |

### 2.5 `builder`

| Type | Requirement | Coupling |
|---|---|---|
| Compute | Its own batch-compute environment (a job queue plus the workers that run jobs from it) — separate from anything `orchestrator-svc` or any other service uses | **Locked**: `orchestrator-svc` dispatches to this environment through a specific cloud vendor's batch-service SDK, the same one from §2.4 |
| External network | None | — |
| Database | **None, and none should ever be granted** | — |
| Object storage | None directly — it receives a scoped, write-only presigned URL per job from `orchestrator-svc` and uploads its result through that, rather than holding any storage credential of its own | — |
| Secrets management | **None.** This is the one non-negotiable requirement in this whole document: this workload's IAM role must grant it nothing beyond pulling its own container image and writing its own logs | — |

This is the only place submitted, untrusted source code is actually built and executed. Its IAM role
holding zero business credentials (no database access, no general object-storage access, no secrets)
is what keeps a compromise of the build process from becoming a compromise of anything else — see this
project's own [rule 1 of `docs/invariants.md`](invariants.md). It needs its own
batch-compute environment and its own IAM role, distinct from `orchestrator-svc`'s.

### 2.6 `composer` (only if you serve cli-legacy targets)

| Type | Requirement | Coupling |
|---|---|---|
| Compute | Its own, separate batch-compute environment — not shared with `builder`'s | **Locked** (same SDK dependency as `builder`) |
| External network | None | — |
| Database | None | — |
| Object storage | Write access to its own container registry, to publish composed build environments it produces | **Locked**: composing and pushing a build environment goes through the same cloud vendor's container-registry APIs |
| Secrets management | None beyond what its registry-push credential requires | — |
| Network segment | Its own — not `builder`'s. `composer` holds a registry-push credential and `builder` runs untrusted code; putting them on one segment means an escape from the sandbox begins adjacent to that credential | **Locked** by the trust boundary, not by any vendor |

Unlike `builder`, `composer` never runs untrusted, submitter-supplied input — it only ever composes
build environments from official, trusted components for a given toolchain pair. That's why its IAM
role is shaped differently (it needs registry-push access `builder` must never have), not because it's
less sensitive — see [rule 18 of `docs/invariants.md`](invariants.md) and
[`docs/specs/build-environments.md`](specs/build-environments.md) if you're standing this up. If you
don't need to serve cli-legacy targets, skip this section entirely.

## 3. Summary table

| Dependency | web | query-svc | verification-svc | orchestrator-svc | builder | composer |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| External network ingress | ✅ | ✅ (if exposed) | ✅ | ❌ | ❌ | ❌ |
| Database | ❌ | ✅ | ✅ | ✅ (same data) | ❌ **never** | ❌ |
| Object storage | ❌ | ❌ | ✅ | ✅ | ❌ (write-only presigned URL, not a credential) | ✅ (own registry only) |
| Async job execution (submit) | ❌ | ❌ | ✅ | — | — | — |
| Async job execution (actually run + consume results) | ❌ | ❌ | ❌ | ✅ | runs *inside* this | runs *inside* its own, separate one |
| Own network segment (subnet + firewall group) | — | — | — | — | ✅ **separate from `composer`** | ✅ **separate from `builder`** |
| Message queue | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Secure storage for database credentials | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Optional external archive key | ❌ | ❌ | ❌ | Optional | ❌ | ❌ |

**`builder` and `composer` each need their own batch-compute environment, IAM role and network
segment** — none of the three shared with `orchestrator-svc` or with each other (see §2.5 and §2.6).
The network segment is the one most easily skipped and the one whose absence is least visible: both
fleets start, both jobs succeed, and the only thing that changed is what a sandbox escape is next to.

## 4. Common deployment combinations

| Scenario | Services needed | Notes |
|---|---|---|
| Full verification service | `web` + `verification-svc` + `orchestrator-svc` + `query-svc` + `builder` (+ `composer` for cli-legacy targets) | Standard full-featured deployment. `builder` is not optional — without it, nothing can actually rebuild a submission |
| Results-browsing site only | `web` + `query-svc` | Doesn't accept new verification requests, only browses existing results; still needs a database |
| Verification backend only (no frontend, no query API) | `verification-svc` + `orchestrator-svc` + `builder` | Submit/check verification jobs directly through the API; `query-svc` is a separate read-only retrieval interface that plays no part in the submit → build → publish chain — not deploying it doesn't affect the verification flow |
| Verification backend + query API (no frontend) | `verification-svc` + `orchestrator-svc` + `builder` + `query-svc` | Same as above, with a read-only query API additionally exposed |
| Static display / placeholder site only | `web` only | No database or async job-execution environment involved |

**Combination not recommended**: deploying `verification-svc` without `orchestrator-svc` (or vice
versa) — submitted verification requests will never be processed and published, or there will be no
entry point to trigger processing. The same applies to omitting `builder`: a deployment that accepts
submissions with no batch-compute environment to run them in queues jobs it can never complete.

## 5. On "freely swappable" — the actual boundary

The application code's infrastructure dependencies fall into two categories, and they should not be
treated the same way:

- **Database, secrets/configuration management**: vendor-neutral at the code level — the database
  goes over a standard-protocol connection string, and configuration is read from environment
  variables, with no call to any cloud vendor's proprietary SDK or feature. Both of these categories
  can freely use any compatible implementation.
- **Object storage, async job-execution environment (batch + message queue)**: **already bound to a
  specific cloud vendor's SDK** at the code level. Object storage does have an abstraction layer (the
  local filesystem is a genuinely usable alternative implementation), but the cloud implementation
  and some call sites still depend on that SDK directly. Batch-job submission and consuming job
  results have no abstraction layer at all — they call that cloud vendor's batch and queue services
  directly, hardcoded. This means that **to actually run the verification pipeline
  (`verification-svc` + `orchestrator-svc` + the `builder` batch-compute environment they dispatch
  into), the code as it stands today requires infrastructure from a cloud vendor compatible with that
  SDK** — this is not a free choice of provider.

This document lists only the **functional dependency** types. It does not prescribe a specific
resource topology (for example, whether to share one load balancer, one database instance, or one
network environment), does not prescribe an orchestration/deployment tool, and does not cover
operational concerns like CI/CD or permission tightening — those depend on your own scale, isolation
needs, and operational habits, but whatever you choose has to work within the coupling boundary
above.
