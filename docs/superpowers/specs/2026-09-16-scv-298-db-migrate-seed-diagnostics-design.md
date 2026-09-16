# SCV-298: Distinguish DDL Failure from TVL-Seed Failure in `db-migrate.yml` — Design

**Jira:** SCV-298 — "db-migrate.yml 的 DDL 与 TVL seed 仍用 && 链在同一命令，seed 失败会留下 schema/code skew"

## Problem

`.github/workflows/db-migrate.yml`'s `migrate` job composes a single shell command string
(`COMMAND`) that runs `prisma migrate deploy` and, on the `deploy` + `query-svc` path, appends
the TVL seed (`scripts/seed-tvl.ts`) with `&&`. This whole string is passed as one container
override (`sh -lc "$COMMAND"`) to a single ECS Fargate task — there are no separate GitHub
Actions steps inside the task, only inside the *workflow* that launches it.

When the DDL migration succeeds but the seed fails, the container still exits non-zero (the
seed's `process.exitCode = 1` in its `.catch()` propagates through `&&`/`sh -lc`). The
database schema has already changed, but the TVL was not (re)seeded — a schema/code skew. The
workflow's current "Fail if the migration task did not succeed" step just emits one generic
`::error::migration task exited N` regardless of which stage failed, forcing whoever is
debugging to manually open the CloudWatch log and figure out whether the DDL itself failed or
the schema changed and seeding failed afterward.

Note: SCV-298's original description ("split into independent workflow steps") does not fit
this architecture — DDL and seed are not separate GitHub Actions steps and cannot be, since
they must run inside the one borrowed task definition's one container command. The applicable
fix is to make the single command internally distinguish and report which stage failed.

## Design

**1. Stage markers inside the composed command**

In the `Run migration task` step's `run:` script (`.github/workflows/db-migrate.yml`, the block
building `COMMAND` from line ~287), insert plain `echo` markers around the seed segment:

- After the base `prisma migrate deploy`/`status` command and before the seed segment begins
  (only reached if the DDL command succeeded, since it's still an `&&` chain): append
  `echo '--- MIGRATE_OK: DDL applied, seeding TVL ---'`.
- After the seed command: append `echo '--- SEED_OK: TVL seed complete ---'`.

These are plain stdout lines already captured by the existing `Print migration task logs` step,
which `tee`s the task's CloudWatch output to `migration.log` in the same job. No new log
plumbing is needed.

**2. Workflow-level diagnosis**

The `Fail if the migration task did not succeed` step currently runs unconditionally on
non-zero exit:
```yaml
- name: Fail if the migration task did not succeed
  if: always() && steps.run.outputs.exit_code != '0'
  run: |
    echo "::error::migration task exited ${{ steps.run.outputs.exit_code }} — see the logs above"
    exit 1
```
It runs after `Print migration task logs` (which already has `if: always() && steps.run.outputs.task != ''`
and writes `migration.log` before this step executes — the existing step ordering already
satisfies this dependency; both steps are in the same job so the file persists between them).

Replace the body to grep `migration.log` for the markers and choose a specific `::error::`:
- `SEED_OK` present → stage markers both succeeded despite a non-zero exit; report the original
  generic message (something unexpected occurred after both stages logged success).
- `MIGRATE_OK` present but not `SEED_OK` → DDL succeeded, seed failed: report the schema/code
  skew explicitly and point at re-running deploy to retry the seed.
- Neither marker present → DDL itself failed; note that TVL seed was never attempted.

This only takes effect on the `deploy` + `query-svc` path where markers are ever emitted; other
action/target combinations will simply never contain either marker, which the "neither present"
branch already handles correctly (DDL failed — accurate for a plain `verification-svc` or
`status` run too, since seed only ever runs on the query-svc deploy path).

**3. No new retry entrypoint**

`prisma migrate deploy` is idempotent against already-applied migrations, so re-triggering the
whole `db-migrate` workflow against `query-svc` is a safe way to retry a failed seed — the DDL
step becomes a no-op and the seed runs again. This design intentionally does NOT add a
seed-only action/entrypoint to `db-migrate.yml`; that would add a second code path (and second
test surface) for a problem the existing entrypoint already resolves safely. If seed-only retry
becomes a real operational pain point later, it can be scoped as its own follow-up.

## Scope

**Files:**
- Modify: `soroban-verification-service/.github/workflows/db-migrate.yml` — only the `COMMAND`
  composition block (~line 287-312) and the `Fail if the migration task did not succeed` step
  (~line 412-416).

No application code, no other workflows, no infra changes.

## Verification

No automated test suite exists for this workflow YAML (consistent with `rollback.yml`,
`deploy.yml`, etc. in this repo). Verification is:
- YAML syntax parse check.
- Structural `grep` check confirming the markers are placed correctly relative to the `&&`
  chain and that the `Fail if...` step's logic branches are all reachable.
- A judgment call at plan-execution time on whether a real dispatch (deliberately breaking TVL
  seed, e.g. by pointing `SCVS_TRUSTED_VERIFIERS_SOURCE` at a bad path in a scratch run) is
  warranted — given this workflow mutates a real database, real verification here needs the
  user's explicit go-ahead, the same way SCV-287's rollback verification did.

## Self-review

- **Placeholder scan:** none found — every step names the exact script/diff to apply.
- **Internal consistency:** the marker-based diagnosis only ever fires on the deploy+query-svc
  path where markers are emitted; every other path degenerates to the pre-existing generic
  "DDL failed" message, which is still accurate there.
- **Scope check:** single file, two related edits — no decomposition needed.
- **Ambiguity check:** "split into independent steps" from the original Jira ticket is
  explicitly reinterpreted per the architecture constraint discovered above; this is called out
  so a future reader doesn't wonder why the ticket's literal suggestion wasn't implemented.
