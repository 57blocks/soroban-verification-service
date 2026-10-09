# Configuration

As built. See `Verified by:` on each claim.

## 1. Ownership boundary

AWS infrastructure is Terraform, owned outside this repository and never created by it
(`docs/invariants.md` rule 8). This repository owns: container images; the environment-variable
contract (`config/env-manifest.yaml`); Prisma migrations and running them; and the
deployment-configuration values it writes at deploy time (rule 23). Everything else — the VPC,
compute, queues, IAM roles, and the values bound to variables — is infrastructure's.

Verified by: `config/deploy/README.md`, `docs/invariants.md` rules 8, 22, 23.

## 2. The environment-variable contract

`config/env-manifest.yaml` is the single declaration of every variable: type, required-ness,
failure mode (`fail: boot | first-use | silent | n/a`), which service reads it, who supplies the
value, and its sensitivity tier. The manifest, the code reading each variable, and each service's
env DTO must agree; CI fails when they don't (rule 10). `config/deploy/<env>/<service>.json` is
generated from the manifest — read that, not this document, for what a deployment must set.

A `required: forbidden` variable is a checked assertion, not documentation: CI fails if the
builder's source reads one, or the rendered task/job definition sets one (rule 11).

`fail:` is what decides what to alarm on. `silent` is the dangerous class: the service boots
healthy and degrades with no error — a green health check does not mean a service is correctly
configured.

Verified by: `eng-tools/check-env-manifest.mjs`, `eng-tools/check-taskdef-boundary.mjs`,
`config/deploy/README.md`.

## 3. Configuration and credentials are separate secrets

The deployment-configuration secret this repository's CI writes and the credentials secret
holding real passwords/keys are never one blob: a grant to read configuration must never
transitively grant reading a database password or a signing key (rule 23, full reasoning there).
A rendered task or job definition is checked against this boundary before it is registered, and
the check fails closed on anything it cannot parse.

Verified by: `eng-tools/check-taskdef-boundary.mjs`, `docs/invariants.md` rule 23.

## 4. What a deployed service reports about itself

A running service exposes its own configuration contract — which variables it received, at what
observability level (`presence`, `value`, or `digest`) — and a deployment's report is checked
against the manifest's expectation for that level, with the expected values and any extra
requirements taken from that deployment's own `config/deploy/<env>/<service>.json`. This is what proves a value actually reached
the process, as opposed to what a task definition merely declares.

Verified by: `eng-tools/assert-config-contract.mjs`, `packages/config/src/env-contract.generated.ts`.

## 5. The web console's own routing

`verification-svc`, `orchestrator-svc`, and `query-svc` build from one shared image
(`docker/service.Dockerfile`); the console builds separately (`docker/web.Dockerfile`) and reads its
API base URL from a build-time argument, `VITE_VERIFY_API_URL` (empty means same origin as the
console itself). The reference `docker-compose.full-stack.yml` runs the three services and the
console on four different ports. This project's own reference deployment additionally fronts all
three with one ALB on one public host — that topology lives in Terraform, outside this repository.

The console's own nginx (`docker/web-nginx.conf`) serves its document root as three cases: a route
the console declares serves its entry document; a real static file serves itself; every other path
answers `404 text/html` with the console's not-found page — a path under `/api/*` included, when
nothing in front of this nginx forwards it elsewhere. `/healthz` is served statically by the same
nginx, independent of the console's route tree, so a route rename cannot take a load balancer's
health check down with it; each backend service also exposes its own
`/api/<service>/v1/health`.

Verified by: `eng-tools/check-host-routing.mjs` (serves the real nginx configuration and generated
route allowlist over a synthetic document root), `eng-tools/assert-host-routing.mjs` (probes a live
deployed origin with no credentials), `docker/web-nginx.conf`, `docker/web.Dockerfile`,
`docker/service.Dockerfile`, `docker/docker-compose.full-stack.yml`, `clients/web/spa-routes.ts`,
`clients/web/test/route-surface.spec.tsx`.

## 6. The published result root is served at the host root, with no path prefix

A published artifact's URL path is its storage key with nothing prepended — `SCVS_PUBLISHER_PREFIX`
is empty in every environment, and this is enforced as an equality check, not a default: a deployment
that reports a non-empty prefix fails, because a stray prefix breaks every published `artifact_url`
while the service stays healthy.

Verified by: `packages/config/src/env-contract.generated.ts`, `packages/config/src/index.ts`,
`eng-tools/check-env-manifest.mjs`.

## 7. Streaming interval must stay under any fronting proxy's idle timeout

The job-status SSE stream re-emits its body on a fixed interval regardless of whether anything
changed, specifically so a connection is never idle long enough for a fronting proxy or load
balancer to close it. Raising that interval past a proxy's idle timeout cuts streams mid-job.

Verified by: `services/verification-svc/src/config/env.dto.ts` (`SCVS_JOB_STREAM_SAFETY_POLL_MS`),
`services/verification-svc/src/config/configuration.ts`.

## 8. Observability: metrics are structured log records, not a cloud SDK call

The builder depends on nothing but the shared core package by design (rule 1), so a metric that
must be emitted from any component — including the builder — is one JSON log record, never a
`PutMetricData`-style SDK call. The record's `metric` field names the metric and `value` carries
the reading; a metric filter selects on the first and extracts the second. Renaming either field,
or a metric's name, breaks every alarm built against it.

The current metric set (queue depth, jobs in flight, job duration, verdict counts, failure-reason
counts, archive/publish/retention/build-log backlogs, per-verifier aggregation latency and outcome,
build-environment composition outcome and duration) is defined in one place, and an emitter cannot
introduce a field name that collides with it.

Verified by: `packages/core/src/metrics.ts` (`METRIC_FIELD`, `METRIC_UNITS`),
`packages/core/src/metrics-test.ts`.

## 9. No runtime alarm on a trusted-image change

There is no mutation path for the trusted-image set at runtime, so nothing alarms on one: a change
to what this verifier trusts can only arrive as a deploy of changed source or configuration, and
the signal is the reviewed change, not a CloudWatch event. An alarm firing on a *runtime*
trusted-image change would itself mean the mutation path had been reintroduced.

Verified by: `docs/invariants.md` rule 16 (no submitter-supplied field may enter a trusted build
environment), `SECURITY.md`.

## 10. Deployment modes

Three modes, each a subset of one layer set: **Verifier-only** (submission + publishing, needs a
database), **Query-only** (aggregation alone, no database — its cache is derived and rebuildable
from published result roots), and **Full stack** (all of it). A publish-only mode with no service
at all is not supported: preflight, submission, and job status are served routes that a static file
cannot answer.

Verified by: `docs/self-hosted-deployment.md`, `docs/infrastructure-requirements.md`.

## 11. A server that binds a port sets its own deadlines

Node's `http.Server` defaults are not a neutral fallback, so no entrypoint is allowed to inherit
them. Two of the three matter for different reasons.

**Keep-alive must outlast whatever fronts the server.** Node closes an idle connection after 5 s;
the ALB in front of the public services holds one for 60 s and will reuse it. The balancer then
sends a request into a connection the server has already closed and answers **502**, at random, to
a client that did nothing wrong. The keep-alive deadline is therefore set above the balancer's idle
timeout, and `FRONTING_PROXY_IDLE_TIMEOUT_MS` carries the balancer's own number so the ordering is
asserted rather than remembered. This couples to `SCVS_JOB_STREAM_SAFETY_POLL_MS` from the opposite
side — §7 requires that one to stay well *below* the same number — and both depend on one value
Terraform owns in another repository.

**The request deadline is what bounds a connection holding an upload.** `POST /v1/uploads/source`
accumulates the body in memory up to `SCVS_MAX_SOURCE_ARCHIVE_BYTES`, so this deadline, and nothing
else, decides how long one slow connection may hold that buffer. Its value is deliberately still
Node's own 300 000 ms: making it explicit and adjustable is a separate change from re-choosing it,
and choosing a lower number needs measured archive sizes and upload durations rather than a guess.

Only one relationship between them is enforced, because only one has a failure mode: the keep-alive
deadline must exceed the fronting proxy's idle timeout. That timeout is itself configuration rather
than a constant, so a deployment behind something other than this one's ALB supplies its own number
and one with nothing in front of it says so with a `0` — the only value among the four where a zero
is meaningful. A zero on any of the three deadlines is refused, because Node reads it as "no
deadline", and so is any value above Node's 32-bit timer ceiling, above which the duration is
truncated and the configured number stops applying. A violation stops the boot rather than being
clamped: a silently substituted value is an unreviewed default again.

No ordering is required *between* the request and headers deadlines, and the headers deadline does
not need to exceed the keep-alive one. Both beliefs are common and both are false here: the request
and headers deadlines are independent, with a stalled head closed at whichever is shorter, and Node
times headers from the first byte of a request rather than from when a connection goes idle. The
shipped defaults — a 10 s headers deadline under a 65 s keep-alive — are exactly the shape the second
belief would forbid. Both deadlines are also swept on `connectionsCheckingInterval` (Node's default,
30 s) rather than armed per socket, so a stalled request outlives its deadline by up to one sweep.

Verified by: `packages/core/src/http-timeouts.ts`, `packages/core/src/http-timeouts-test.ts`,
`eng-tools/check-http-timeouts.mjs`, `config/env-manifest.yaml`.
