# `config/deploy/` — the per-service deployment contract

**Generated. Do not edit.** Source is [`../env-manifest.yaml`](../env-manifest.yaml); regenerate with
`pnpm run generate:deploy-env`. It writes one file per service per environment,
`config/deploy/<env>/<service>.json`, for every environment named in the manifest's
`meta.environments`.

[`_EXAMPLE/verification-svc.json`](_EXAMPLE/verification-svc.json) is a snapshot of one such file, so
you can see the shape before running anything. It is an illustration, not an input: nothing reads it.

## What these are

A flat, per-service statement of every environment variable that service receives, where each value
comes from, and what its absence costs. Your deployment pipeline renders a container task definition
from it — [`eng-tools/render-taskdef.mjs`](../../eng-tools/render-taskdef.mjs) builds the definition
and [`eng-tools/sync-secrets.mjs`](../../eng-tools/sync-secrets.mjs) writes the values.

**A file carries a value only where this repository is the authority for it.** An identifier carrying
an account id, a region, or a revision carries none — a stale identifier that reads as authoritative
is worse than an absent one, and those entries name a lookup path resolved at deploy time instead.

## Two secrets, and why they stay two

Every variable a resident service reads arrives as a secret reference rather than a literal. `tier:`
in the manifest says what a variable discloses; `store` in the artifact says which secret holds it:

| tier | `store` | what holds it |
| --- | --- | --- |
| `secret` | `credential` | a dedicated secret per credential — a database password, an archive signing key |
| `infrastructure`, `knob` | `config` | one configuration secret per service, one key per variable |

**Keeping these two apart is load-bearing**, and it is the part most worth copying if you build your
own pipeline: a grant to read a request timeout must not transitively read a database password. The
answer is splitting the secrets, not using two different stores.

### Batch job definitions are the exception, deliberately

`builder.json` and `composer.json` have **no** `secrets` block: their variables stay plaintext in the
job definition. Reading a secret needs a secrets-manager grant on the execution role, and the
builder's roles are scoped to zero business permissions
([rule 1 of `docs/invariants.md`](../../docs/invariants.md)). The builder's variables
are sandbox limits — CPU, memory, pids, a non-root uid — with nothing to protect and everything to
lose by making the sandbox reach a credential store in order to start.

## Reading a variable's row

| `source` | What is in the file | What a deploy does with it |
| --- | --- | --- |
| `literal` | `value` — authoritative | write it verbatim |
| `terraform` | `value_from_output`, a path into your infrastructure's own outputs | resolve at deploy time, then write it |
| `secret` | `secret` + `json_key` | compose a secret reference; never written by the pipeline |
| `image-build` | `value`, plus a note | nothing — the image supplies it |

Two fields exist for cases a plain value cannot express. **`value_ref`** points at the decision that
settles a value that is ours to decide and not writable as a literal. **`value_is_authoritative:
false`** records a stable resource name for greppability while leaving ownership elsewhere — if your
infrastructure disagrees, your infrastructure is right.

## Sections that are prohibitions, not configuration

Three sections say what must **not** be set. They are not advisory:

- **`forbidden`** — must never be set for this service. For `builder.json` this is
  [rule 1 of `docs/invariants.md`](../../docs/invariants.md)'s trust boundary: the
  sandbox runs the only untrusted code in the system and holds no database access and no business
  cloud credentials. [`eng-tools/check-taskdef-boundary.mjs`](../../eng-tools/check-taskdef-boundary.mjs)
  enforces it before every registration, and **a non-zero exit means the document about to be
  registered crosses that line. It must never be worked around to unblock a deploy.**

  One deliberate asymmetry: the job-role rule applies to the **builder only**. The composer is also a
  batch job but is the *trusted* fleet — no submitted input reaches it, and
  [rule 18 of `docs/invariants.md`](../../docs/invariants.md) requires it to hold
  registry-push access. Asserting the rule for both would fail every composer deploy on its own
  design, and a check that cries wolf is one people learn to bypass.
- **`per_invocation`** — injected per job at submit time. A value baked into the job definition is a
  stale job spec that *will* be used.
- **`not_in_deployment`** — read by the code and fine locally, wrong deployed. `DATABASE_URL` is the
  case: setting it embeds the password in a URL, turning a secret reference into a string.

## `fail` — what a missing value costs

This is the field to pick alarms from.

| `fail` | Meaning |
| --- | --- |
| `boot` | the process refuses to start — visible as a task-start loop |
| `first-use` | boots healthy, fails the first request that needs it — needs a smoke test |
| `silent` | **no error, degraded behaviour** — a green health check proves nothing |
| `n/a` | optional, with a working default |

The `silent` class is why this contract exists. Leave the job-state-change queue URL unset and
orchestrator-svc queues jobs, dispatches them, builds them successfully, and never completes one —
with nothing failing anywhere. [`eng-tools/assert-config-contract.mjs`](../../eng-tools/assert-config-contract.mjs)
checks a deployed service's own boot line against the manifest
(the configuration-observability property `docs/invariants.md` rules 22–23 absorb), which proves presence; for a
variable whose value is not recorded here, it cannot prove correctness.

## `invariants`

`identical_across` names services whose listed variables must be **byte-identical**. Today that is
the result storage across `orchestrator-svc` and `query-svc`: one writes the published result tree
and the other reads it, so a mismatch means the reader looks where the writer never wrote — and both
services stay perfectly healthy.
