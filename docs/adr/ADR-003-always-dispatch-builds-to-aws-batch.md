# ADR-003: Always dispatch builds to AWS Batch; no in-process fallback

> **Status**: Accepted (recorded 2026-07-27 — decision predates this record)
> **Scope**: `services/orchestrator-svc`, local development setup

## Context

An earlier iteration could run a build in-process as a local fallback when Batch was not configured.
That is the ergonomic choice for local development: no AWS account needed, faster iteration.

It also means the code path exercised locally is not the code path that runs in production. For a
service whose entire security model rests on the build happening inside an isolated, credential-less
sandbox, a fallback that runs untrusted source *in the orchestrator's own process* is not a
convenience — it is a hole that only appears when configuration is incomplete, which is exactly when
nobody is looking.

## Decision

`orchestrator-svc` **always** submits an AWS Batch job. There is no local-only path, and no
conditional branch that could reintroduce one.

The service fails fast at startup when the Batch job queue ARN, job definition ARN,
`SCVS_JOB_STATE_CHANGE_QUEUE_URL`, or the staging bucket is missing. Local development talks to the
team's shared dev AWS account.

Terminal outcomes arrive asynchronously: Batch job state change → EventBridge → SQS →
`orchestrator-svc`'s consumer, which reconstructs the result from the uploaded `recipe.json`.

## Consequences

**Easier**

- One code path. What runs locally is what runs in production, including the IAM boundary and the
  EventBridge→SQS delivery semantics.
- Failures in the asynchronous path surface during development instead of first appearing in
  staging.

**Harder / constrained**

- Local development requires real AWS credentials and shared-account resources. A new contributor
  cannot run the pipeline end-to-end without a teammate provisioning access — this is a real
  onboarding cost, accepted deliberately.
- The feedback loop for a build change is a Batch job, not a local process.
- The SQS consumer must tolerate duplicate and out-of-order deliveries, because EventBridge and SQS
  guarantee neither.
- Tests that would need a real build are integration tests against the dev account, not unit tests.
  `test/integration/` is stubbed for this reason and not yet populated.

## Alternatives considered

- **Keep the in-process fallback, gated behind an explicit env flag** — rejected: the flag would be
  set in exactly the environments where the isolation matters least to the person setting it, and a
  path that exists will eventually run somewhere it should not.
- **LocalStack or a Batch emulator for local dev** — rejected for now: it reproduces the API surface
  but not the IAM boundary or the container isolation, so it would restore the "local ≠ production"
  gap this decision exists to close. Worth revisiting if the onboarding cost becomes the dominant
  complaint.

## References

- `services/orchestrator-svc/src/modules/verification-pipeline/batch-dispatch.service.ts`
- `services/orchestrator-svc/src/modules/batch-events/batch-event-handler.service.ts`
- `README.md` — "Quick Start From Zero", step 5
- [ADR-002](ADR-002-builder-holds-no-business-credentials.md) — what the isolation buys
