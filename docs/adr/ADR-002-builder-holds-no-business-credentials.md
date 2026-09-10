# ADR-002: The builder holds no business credentials

> **Status**: Accepted (recorded 2026-07-27 — decision predates this record)
> **Scope**: `services/builder`, the deployment contract's IAM section, the orchestrator↔builder contract

## Context

`services/builder` executes attacker-influenced code. A submitter supplies a source archive and, for
retroactive contracts, the container image to build it in. Whatever runs there must be assumed
hostile.

The obvious implementation gives the builder an AWS role that can read the staging bucket, write
results, and update the job row — it is the component that knows the outcome, after all. That
implementation makes a sandbox escape equivalent to full pipeline compromise: the attacker inherits
S3 write access to the published result tree and can forge verification outcomes for contracts they
do not control. Forged verification results are the highest-severity failure this service has,
because the entire product is "you can trust this claim".

## Decision

The builder is structurally incapable of doing damage, rather than merely instructed not to.

1. **No database access.** `services/builder` does not depend on `@scvs/db`. Private-upload source
   references are resolved to presigned URLs by `orchestrator-svc` *before* dispatch.
2. **No AWS SDK, and no AWS dependency at all.** `services/builder`'s `package.json` does not list
   `@scvs/aws`. Output leaves via a single plain `fetch(url, { method: "PUT" })` to a presigned URL
   minted upstream — see `services/builder/src/modules/builder/upload.ts`.
3. **Scoped IAM roles.** The Batch instance/execution roles grant ECR pull and CloudWatch Logs
   only — no S3, no DynamoDB, no Secrets Manager, and the job definition sets no `jobRoleArn` at all.
   `docs/design/aws-deployment.md` states
   that this asymmetry with `orchestrator-svc`'s role is deliberate and must not be unified.
4. **Container hardening on the inner rebuild.** `--cap-drop ALL`, `--security-opt
   no-new-privileges`, `--network none`, `--read-only`, non-root `--user`, tmpfs `/tmp`, read-only
   source mount, writable output mount only.
5. **Network only where unavoidable.** Dependencies are fetched by a separate `cargo vendor
   --locked` prefetch step with an allowlist that rejects private, local, and cloud-metadata hosts.
   The final build runs offline.
6. **The builder does not decide the verdict.** It reports what happened; `orchestrator-svc`
   compares the rebuilt hash against the deployed hash on the trusted host.

   > **Note (2026-08-12, decision D7)**: "compares the rebuilt hash" understates what TB3 now
   > requires, and the gap is the load-bearing part of this ADR. The trusted side does not compare a
   > hash the sandbox reported — it **fetches the uploaded bytes and computes the hash itself**
   > (`hashUploadedArtifact`), then derives the verdict from that against a freshly read deployed
   > hash. `BuildArtifact.rebuilt_wasm_hash` is evidence only, and on disagreement the bytes win.
   > Read as written, this point permits a sandbox-reported hash to reach a verdict, which is the one
   > failure that defeats the service.

## Consequences

**Easier**

- A sandbox escape yields ECR pull and log write. It cannot read the database, cannot write to the
  published result tree, and cannot forge a result — the presigned URL it holds is scoped to one
  key for one job.
- The trust boundary is checkable in CI-adjacent ways: it is a dependency list, not a code review
  opinion.

**Harder / constrained**

- The orchestrator↔builder contract cannot live in `packages/aws`, because depending on it would
  pull the AWS SDK into the sandbox image. This is why `BatchJobParams`/`BuildArtifact` live in
  `@scvs/core` — see [ADR-005](ADR-005-dto-ownership-follows-use.md).
- Everything the builder needs must be passed in at dispatch: it cannot look anything up. Adding an
  input means extending `BatchJobParams`, not adding a client.
- Output is one presigned PUT. Uploading a second artifact (e.g. the raw rebuilt `.wasm`) requires a
  second presigned URL field on `BatchJobParams` — noted as a known limitation in `upload.ts`.

  > **Note (2026-08-22)**: "passed in at dispatch" now includes *by presigned GET*. The
  > job-params document itself travels as a staged blob the container fetches with a plain
  > `fetch(url)` (`SCVS_JOB_PARAMS_URL`, selected by `SCVS_JOB_PARAMS_TRANSPORT`), exactly like the
  > source archive the materialiser has always fetched this way. The boundary is unchanged — a
  > presigned URL is a capability scoped to one key, not an identity, and the sandbox image still
  > holds no SDK and no credentials. See
  > `docs/features/sandbox-hardening/decisions/job-params-travel-by-presigned-get.md`.

  > **Note (2026-08-12, decision D7)**: this shipped, and the limitation is discharged.
  > `BatchJobParams` carries a second write-scoped target and the builder uploads both `recipe.json`
  > and the rebuilt Wasm itself. `upload.ts` carries no such note — it never did, or it was removed
  > with the fix. **The consequence is what matters and it is unchanged**: each target is one key for
  > one job, so two write-scoped URLs are still not a credential and still cannot forge a result. The
  > count was never the property; the scoping is. Recorded because the trusted side now *needs* those
  > bytes — TB3 computes the verdict over them — so a reader must not conclude from this line that the
  > rebuilt Wasm stays inside the sandbox. A runbook did conclude exactly that (F056).

## Alternatives considered

- **Give the builder a narrowly scoped S3 write role** — rejected: "narrow" degrades over time, and
  a role that can write anywhere in the result prefix can forge results for other contracts. A
  presigned URL for one key expires and cannot be widened.
- **Let the builder write its own job status to the database** — rejected: it would need DB
  credentials, and it would let untrusted code declare its own verdict.
- **Run the build on the resident host with a container sandbox** — rejected: shares a credential
  environment and a kernel with the component holding real permissions.

## References

- `services/builder/src/modules/builder/upload.ts` — the "no `@scvs/aws`" rationale, in the code
- `docs/design/aws-deployment.md` — role separation and why it must not be unified
- `SECURITY.md` — reporting scope and the boundaries already enforced
- [ADR-003](ADR-003-always-dispatch-builds-to-aws-batch.md) — why there is no in-process build path
