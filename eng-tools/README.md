# `eng-tools/`

Every tool this repository runs outside the build. One row per file — a row is required, and
[`check:tool-index`](check-tool-index.mjs) fails the build when the directory and this table disagree.

**The first segment of a command name answers three questions: who runs it, with what credentials, and
what a red run means.** That is the whole convention.

| prefix | who runs it | credentials | red means |
| :---- | :---- | :---- | :---- |
| `check:` | a workflow — `ci.yml` on every pull request unless its row says otherwise | **no AWS**, ever | the pull request is wrong. Green on `main`, always |
| `generate:` | an author; CI then diffs the result | none | — |
| `deploy:` | your deployment pipeline, and an operator with `--dry-run` | a deploy role in your own account | the deploy is refused |
| `release:` | your release pipeline | a registry token | the release is refused |
| `e2e:` | the E2E harness | a live environment | the fixture set is inconsistent |
| `report:` | `ci.yml`, on every pull request | none | — **it has no red**. The step publishes what it found and exits 0 |
| `ops:` | an operator, by hand, against one live environment | that environment's database and result bucket | the environment needs attention; nothing about the pull request |
| `dev:` `db:` `test:` | an author, locally | local Postgres | — |

Two rules follow from the table and are enforced:

- **A `check:` that no workflow runs is a defect.** Wire it, or give it the prefix that says who does.
- **A `check:` needs no AWS credentials.** A tool that reads a live environment is not a `check:`
  whatever it asserts — give it a prefix that says so, and add a row to the table above.

A **command** has a shebang and exactly one script name. A **library** has neither, and at least one
importer. Neither may exist without a row here. A throwaway script does not belong here at all — this directory is the repository's command surface,
not its scratch directory.

## Gates — `check:`

| file | command | run by | what it asserts |
| :---- | :---- | :---- | :---- |
| [`check-env-manifest.mjs`](check-env-manifest.mjs) | `check:env` | `ci.yml` | `config/env-manifest.yaml`, the code that reads each variable, and each service's `env.dto.ts` name the same set — including the `forbidden:` lists themselves |
| [`check-deployment-data.mjs`](check-deployment-data.mjs) | `check:deployment-data` | `ci.yml` | no tracked file names one deployment's data — `config/deploy/<env>/…` resolved from this tree, or a `config/trusted-verifiers.<env>.json` composed for a container to read. The shape lives here; the values belong to whoever runs a deployment |
| [`check-workflow-syntax.mjs`](check-workflow-syntax.mjs) | `check:workflows` | `ci.yml` | duplicate YAML keys, `env`-context reads at job level, invalid `run` blocks, and descriptor calls in jobs that never checked out |
| [`check-workflow-pins.mjs`](check-workflow-pins.mjs) | `check:workflow-pins` | `ci.yml` (needs `fetch-depth: 0`) | every reference a workflow here makes to THIS repository names a commit whose copy of the referenced path is this tree's. `uses:` cannot be an expression, so a caller's pin reaches the workflow it names and nothing below it; this is what makes that pin transitive. `-- --write` bumps a stale one |
| [`check-credentialed-jobs.mjs`](check-credentialed-jobs.mjs) | `check:credentialed-jobs` | `ci.yml` | two rules over the jobs that assume an AWS role. One: none does so before proving the ref it runs is an ancestor of `main` — by running `assert-deploy-ref.mjs` at a lower step index than its first `configure-aws-credentials`, by depending on a job that does, or by gating every credentials step on `inputs.on_main`, the graded path where an off-main ref still runs and simply gets no credentials. Two: none interpolates `${{ inputs.* }}` into a `run:` body, where the expression becomes the script's own source text — [`credentialed-job-inputs.json`](credentialed-job-inputs.json) is that rule's ratchet, and `-- --write-baseline` can only shrink it |
| `check-vocabulary.mjs` | `check:vocabulary` | `ci.yml` | no instructing document uses a superseded term |
| [`check-test-row-cleanup.mjs`](check-test-row-cleanup.mjs) | `check:test-row-cleanup` | `ci.yml` | a suite deletes only rows it created, scoped by an `in:` on a column it owns |
| [`check-builder-isolation.mjs`](check-builder-isolation.mjs) | `check:builder-isolation` | `ci.yml` | no builder entrypoint reaches both container-execution capability and attacker-controlled input |
| [`check-core-exports.mjs`](check-core-exports.mjs) | `check:core-exports` | `ci.yml` | every `@scvs/core` module is reachable — re-exported by the barrel, published as a subpath, or declared internal with what uses it — and no export points at a module that is gone |
| [`check-module-surfaces.mjs`](check-module-surfaces.mjs) | `check:module-surfaces` | `ci.yml` | every cross-module import in `orchestrator-svc` goes through the target module's `index.ts`, Nest's own `*.module.ts` wiring aside |
| [`check-http-timeouts.mjs`](check-http-timeouts.mjs) | `check:http-timeouts` | `ci.yml` | every entrypoint that binds a port also applies the HTTP server deadlines, which lives past `listen()` where no test reaches it |
| [`check-fixture-tables.mjs`](check-fixture-tables.mjs) | `check:fixture-tables` | `ci.yml` | the compose-built fixtures' `(cliver, rsver)` pairs agree across the three places that record them |
| [`check-mount-paths.mjs`](check-mount-paths.mjs) | `check:mount-paths` | `deploy-builder.yml`, `deploy-composer.yml` | every declared bind mount is host-visible at its own path |
| [`check-tool-index.mjs`](check-tool-index.mjs) | `check:tool-index` | `ci.yml` | this table, and the two rules above it |
| [`check-docs.mjs`](check-docs.mjs) | `check:docs` | `ci.yml` | tracked docs stay under their byte budget, every relative link resolves, a spec's `Verified by:` names a real test, `docs/invariants.md`'s code-location column names a real path, and no tracked file outside an applied migration names a `docs/` path that does not exist. Each rule activates only once its target file exists |
| [`check-secrets.mjs`](check-secrets.mjs) | `check:secrets` | `ci.yml` (needs a Docker daemon; no network beyond the image pull) | this repository holds no gitleaks finding and no deployment identifier beyond what [`internal-identifiers.json`](internal-identifiers.json) already records. That baseline is a ratchet: it only shrinks |
| [`check-host-routing.mjs`](check-host-routing.mjs) | `check:host-routing` | `ci.yml` (needs a Docker daemon; no network beyond the image pull) | serves `docker/web-nginx.conf` and the generated route allowlist on real nginx over a synthetic document root, and probes what each position answers — a console route the entry document, a real file itself, everything else `404` |
| [`check-composition-template.mjs`](check-composition-template.mjs) | `check:composition-template` | `composition-template.yml` (dispatch; needs Docker and the network) | the composed build environment builds, and both halves of its `(cliver, rsver)` pair report what the template claims |
| [`check-composition-matrix.mjs`](check-composition-matrix.mjs) | `check:composition-matrix` | `composition-template.yml` (dispatch; needs Docker and the network) | the same gate across every recorded pair, not the one it happens to default to |

## Reports — `report:`

Run for the document they produce, never for a verdict. A `report:` exits 0 unconditionally — a tool
that can exit non-zero is a `check:` wearing the wrong name — and writes its finding to
`$GITHUB_STEP_SUMMARY`, because output that only reaches a log has reported nothing.

| file | command | run by | what it publishes |
| :---- | :---- | :---- | :---- |
| [`report-advisories.mjs`](report-advisories.mjs) | `report:advisories` | `ci.yml` | every `pnpm audit` advisory, split by whether its path leaves the workspace through a `dependencies` edge of something that ships. Reads the npm advisory database; no AWS |

## Generators — `generate:`

| file | command | writes |
| :---- | :---- | :---- |
| [`generate-env-contract.mjs`](generate-env-contract.mjs) | `generate:env-contract` | `packages/config/src/env-contract.generated.ts` — the descriptor `check:env` compares against |
| [`generate-deploy-env.mjs`](generate-deploy-env.mjs) | `generate:deploy-env` | `config/deploy/<env>/<service>.json`, the flat per-service deployment contract |
| [`pin-differential-oracles.mjs`](pin-differential-oracles.mjs) | `generate:differential-oracles` | `services/builder/test/differential/oracles.ts`, resolved against the registry |
| [`reset-local-db.mjs`](reset-local-db.mjs) | `db:reset:local` | nothing — it truncates the local development database, in foreign-key order |
| [`generate-third-party-notices.mjs`](generate-third-party-notices.mjs) | `generate:third-party-notices` | `THIRD-PARTY-NOTICES`, from the production dependency graph — Apache-2.0 §4(d)'s propagation. Refuses to write one if an unreviewed copyleft licence has entered the graph, or a reviewed one has left it |

## Deployment — `deploy:` (`docs/invariants.md` rule 23)

Read-only unless the row says otherwise. Each takes `--env` and `--service`; the two writers take
`--dry-run`.

| file | command | run by | what it does |
| :---- | :---- | :---- | :---- |
| [`render-taskdef.mjs`](render-taskdef.mjs) | `deploy:render-taskdef` | your deployment pipeline | prints the task definition CI would register — the RUNNING one with the image and every variable replaced, everything else byte-for-byte |
| [`render-migrate-taskdef.mjs`](render-migrate-taskdef.mjs) | `deploy:render-migrate-taskdef` | `db-migrate.yml` | prints the one-off migration task definition: the target service's running one cut down to the variables `db-migrate.json` allows, pinned by digest, under the migration's own execution role and with no task role |
| [`sync-secrets.mjs`](sync-secrets.mjs) | `deploy:sync-secrets` | your deployment pipeline | **writes** one service's configuration into `scvs/<env>/<service>/config`. Never touches a credential |
| [`check-taskdef-boundary.mjs`](check-taskdef-boundary.mjs) | `deploy:check-taskdef` | your deployment pipeline, before every register | asserts a rendered task or job definition against rule 1's trust boundary (`docs/invariants.md`) before anything registers it. Fails closed |
| [`check-descriptor-fields.mjs`](check-descriptor-fields.mjs) | `deploy:check-descriptor` | an operator | does `/scvs/<env>/ci/descriptor` carry every field the manifest resolves from it? The acceptance test for a descriptor change applied in your infrastructure |
| [`assert-config-contract.mjs`](assert-config-contract.mjs) | `deploy:check-config-contract` | your deployment pipeline | the `[config-contract]` line each deployed service logs matches the manifest and the deployment's own `config/deploy/<env>/` contracts (`--contracts <dir>`) |
| [`assert-host-routing.mjs`](assert-host-routing.mjs) | `deploy:check-host-routing` | your deployment pipeline, and an operator troubleshooting a routing incident | black-box: a deployed origin answers every position [`docs/specs/configuration.md`](../docs/specs/configuration.md) §5 names. **No credentials of any kind** — HTTPS only |
| [`assert-deploy-ref.mjs`](assert-deploy-ref.mjs) | `deploy:check-ref` | your deployment pipeline | refuses a deploy whose commit is not an ancestor of `main`. **No credentials** — pure git, and the first step of a deploy that can fail |
| [`assert-sdk-channel-alignment.mjs`](assert-sdk-channel-alignment.mjs) | `deploy:check-sdk-channel` | your deployment pipeline | does the dist-tag serving an environment resolve to a build of the commit that environment runs? Hard on `staging`, a warning on `dev`. Reads the registry, so it holds the publish role rather than the deploy role |

## Release — `release:`

| file | command | run by | what it does |
| :---- | :---- | :---- | :---- |
| [`resolve-release-channel.mjs`](resolve-release-channel.mjs) | `release:resolve-channel` | your release pipeline | the one place that decides what a git ref releases. Runnable locally with `--ref` |
| [`stamp-sdk-version.mjs`](stamp-sdk-version.mjs) | `release:stamp-version` | your release pipeline | **writes** the resolved version and commit into `clients/sdk/package.json`. CI's only real writer of a version |
| [`check-published-dist-tags.mjs`](check-published-dist-tags.mjs) | `release:check-dist-tags` | your release pipeline | the dist-tag this run wrote resolves to the version it published, and `latest` never holds a prerelease |
| [`check-sdk-pack-install.mjs`](check-sdk-pack-install.mjs) | `soroban-verification-client` `check:packaging` | `ci.yml`, your release pipeline | packs the SDK, installs the tarball outside the workspace, runs one aggregation through it |
| [`check-sdk-registry-install.mjs`](check-sdk-registry-install.mjs) | `soroban-verification-client` `check:registry-install` | your release pipeline | installs the SDK from the **registry** and asserts what a consumer can actually see |

## E2E harness — `e2e:`

Each needs a live environment and a run's artifacts, which is why none of them is a `check:`.

| file | command | run by |
| :---- | :---- | :---- |
| [`generate-e2e-ci-inventory.mjs`](generate-e2e-ci-inventory.mjs) | `e2e:generate-inventory` | the E2E harness |
| [`check-e2e-fixture-inventory.mjs`](check-e2e-fixture-inventory.mjs) | `e2e:check-fixtures` | the E2E harness |
| [`generate-e2e-upgrade-inventory.mjs`](generate-e2e-upgrade-inventory.mjs) | `e2e:generate-upgrade-inventory` | `run-upgrade-normal-lifecycle.sh` |
| [`check-e2e-upgrade-inventory.mjs`](check-e2e-upgrade-inventory.mjs) | `e2e:check-upgrade-fixtures` | `run-upgrade-normal-lifecycle.sh` |
| [`write-e2e-summary.mjs`](write-e2e-summary.mjs) | `e2e:summary` | `run-e2e-test.mjs`, `run-smoke.ts` |

## Operations — `ops:`

Run by hand against one live environment, with that environment's credentials. Never in CI: a red run says
the environment needs attention, not that the pull request is wrong.

| file | command | run by |
| :---- | :---- | :---- |
| [`reconcile-published-status-links.mjs`](reconcile-published-status-links.mjs) | `ops:reconcile-published-status-links` | an operator |

Reports by default. `--apply` marks jobs whose links are genuinely missing as pending, and does nothing else
— a published verdict that disagrees with its job row is reported for a human, because rewriting one from a
script is a decision rather than a repair.

## Libraries

No shebang, no script name, read or imported by the tools above.

| file | imported by | what it is |
| :---- | :---- | :---- |
| [`credentialed-job-inputs.json`](credentialed-job-inputs.json) | `check-credentialed-jobs.mjs` | the `${{ inputs.* }}` occurrences still reaching a credentialed job's `run:`, per workflow and job. A ratchet, not an allowlist: zero is the goal, and each entry records an input the job happens to defend itself against rather than one the `workflow_call` contract constrains |
| [`internal-identifiers.json`](internal-identifiers.json) | `internal-identifiers.mjs` | the identifiers no entropy scanner recognises — an account id held as a SHA-256 rather than a literal, because this directory ships in the mirror — and the per-file baseline the scrub drains |
| [`internal-identifiers.mjs`](internal-identifiers.mjs) | `check-secrets.mjs` | the one copy of each identifier pattern, and the redaction that pairs with it — a rule the gate knows and the exporter does not is the hole the prototype export shipped nine resource ids through |
| [`env-manifest.mjs`](env-manifest.mjs) | the manifest readers | `config/env-manifest.yaml`'s reader and resolver |
| [`composition-pairs.mjs`](composition-pairs.mjs) | the composition gates | the `(cliver, rsver)` pairs worth composing, and why each is in the list |
| [`sdk-declaration-typecheck.mjs`](sdk-declaration-typecheck.mjs) | both SDK install gates | does an installed tree's declaration graph resolve for a consumer outside the workspace |
| [`release-channels.mjs`](release-channels.mjs) | the resolver and both deploy assertions | the channel table, which dist-tag serves which environment, the SDK surface, and the ancestor-of-`main` proof |
