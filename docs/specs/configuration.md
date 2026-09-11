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
against the manifest's expectation for that level. This is what proves a value actually reached
the process, as opposed to what a task definition merely declares.

Verified by: `eng-tools/assert-config-contract.mjs`, `packages/config/src/env-contract.generated.ts`.

## 5. Host routing contract

One public host serves three namespaces under one TLS termination point: `/api/verification/*`
and `/api/query/*` route to their services with a JSON `404` envelope for anything unclaimed under
`/api/*`; a route the web console declares serves its entry document; a real static file serves
itself; everything else answers `404 text/html` with the console's not-found page. The discriminator
between a program caller and a browser caller is the path prefix, not content negotiation.

The health-check path (`/healthz`) is distinct from each service's own routed health endpoint
(`/api/<service>/v1/health`) and is served statically, independent of the route tree, so a route
rename cannot take the load balancer's health check down with it.

This contract is checked two ways: statically, serving the real nginx configuration and the
generated route allowlist over a synthetic document root; and black-box, against a live deployed
origin, with no credentials of any kind.

Verified by: `eng-tools/check-host-routing.mjs`, `eng-tools/assert-host-routing.mjs`,
`docker/web-nginx.conf`, `clients/web/spa-routes.ts`,
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

## Drift notes

The internal design documents this spec was rewritten from are written as a live-account operational
journal — dated incident narratives, specific AWS resource identifiers,
IAM simulate-policy transcripts, and account-rebuild history — rather than as a standing contract.
Nearly all of that is out of scope for a public spec: it describes one operator's account at one
point in time, not a promise this codebase keeps. What is carried forward above is only what
survives being true regardless of which account runs it.

Two concrete drifts worth recording:

- The source documents' observability section (§11.2) lists 9 metrics. The current code
  (`packages/core/src/metrics.ts`) defines 13: `source_publish_backlog`, `retention_backlog`, and
  `build_log_expiry_backlog` are not in the source design's table, and `environment_composition_*`
  postdates the build-environment composition feature the source design predates. This spec's
  metric list (§8) follows the code, not the older design document.
- The source documents describe extensive not-yet-applied infrastructure state (a composer
  security group that does not exist yet, an unresolved staging environment, specific dated IAM
  grants) as of a specific account snapshot. None of that is a property of this codebase — it is
  the state of one deployment on one date — and none of it is carried into this spec.

## What was cut, and why

Everything else in the two source documents (207KB total) was operational detail, not contract:
live AWS resource identifiers and ARNs; dated incident/investigation narratives; IAM
`simulate-principal-policy` transcripts; the account rebuild history; the AWS CLI commands in the
former "verify this document against the account" section; the full environment-variable-by-variable
walkthrough (superseded by the manifest itself, §2); and the non-functional-requirement targets,
audit scope, runbook list, and documentation-deliverables table, which are operational planning
artifacts with no standing code location to verify against. `docs/self-hosted-deployment.md` and
`docs/infrastructure-requirements.md` already cover the operational "how to provision this"
ground and are not duplicated here.
