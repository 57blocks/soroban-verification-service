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
| [`check-workflow-syntax.mjs`](check-workflow-syntax.mjs) | `check:workflows` | `ci.yml` | duplicate YAML keys, `env`-context reads at job level, invalid `run` blocks, and descriptor calls in jobs that never checked out |
| `check-vocabulary.mjs` | `check:vocabulary` | `ci.yml` | no instructing document uses a superseded term |
| [`check-test-row-cleanup.mjs`](check-test-row-cleanup.mjs) | `check:test-row-cleanup` | `ci.yml` | a suite deletes only rows it created, scoped by an `in:` on a column it owns |
| [`check-builder-isolation.mjs`](check-builder-isolation.mjs) | `check:builder-isolation` | `ci.yml` | no builder entrypoint reaches both container-execution capability and attacker-controlled input |
| [`check-fixture-tables.mjs`](check-fixture-tables.mjs) | `check:fixture-tables` | `ci.yml` | the compose-built fixtures' `(cliver, rsver)` pairs agree across the three places that record them |
| [`check-mount-paths.mjs`](check-mount-paths.mjs) | `check:mount-paths` | `deploy-builder.yml`, `deploy-composer.yml` | every declared bind mount is host-visible at its own path |
| [`check-tool-index.mjs`](check-tool-index.mjs) | `check:tool-index` | `ci.yml` | this table, and the two rules above it |
| [`check-docs.mjs`](check-docs.mjs) | `check:docs` | `ci.yml` | tracked docs stay under their byte budget, every relative link resolves, a spec's `Verified by:` names a real test, and `docs/invariants.md`'s code-location column names a real path. Each rule activates only once its target file exists |
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
| [`generate-third-party-notices.mjs`](generate-third-party-notices.mjs) | `generate:third-party-notices` | `THIRD-PARTY-NOTICES`, from the production dependency graph — Apache-2.0 §4(d)'s propagation. Refuses to write one if a copyleft licence has entered the graph |

## Deployment — `deploy:` (`docs/invariants.md` rule 23)

Read-only unless the row says otherwise. Each takes `--env` and `--service`; the two writers take
`--dry-run`.

| file | command | run by | what it does |
| :---- | :---- | :---- | :---- |
| [`render-taskdef.mjs`](render-taskdef.mjs) | `deploy:render-taskdef` | your deployment pipeline | prints the task definition CI would register — the RUNNING one with the image and every variable replaced, everything else byte-for-byte |
| [`sync-secrets.mjs`](sync-secrets.mjs) | `deploy:sync-secrets` | your deployment pipeline | **writes** one service's configuration into `scvs/<env>/<service>/config`. Never touches a credential |
| [`check-taskdef-boundary.mjs`](check-taskdef-boundary.mjs) | `deploy:check-taskdef` | your deployment pipeline, before every register | asserts a rendered task or job definition against rule 1's trust boundary (`docs/invariants.md`) before anything registers it. Fails closed |
| [`check-descriptor-fields.mjs`](check-descriptor-fields.mjs) | `deploy:check-descriptor` | an operator | does `/scvs/<env>/ci/descriptor` carry every field the manifest resolves from it? The acceptance test for a descriptor change applied in `soroban-aws-infrastructure` |
| [`assert-config-contract.mjs`](assert-config-contract.mjs) | `deploy:check-config-contract` | your deployment pipeline | the `[config-contract]` line each deployed service logs matches what the manifest says it should have received |
| [`assert-host-routing.mjs`](assert-host-routing.mjs) | `deploy:check-host-routing` | your deployment pipeline, and an operator troubleshooting a routing incident | black-box: a deployed origin answers every position [`docs/specs/configuration.md`](../docs/specs/configuration.md) §5 names. **No credentials of any kind** — HTTPS only |
| [`assert-deploy-ref.mjs`](assert-deploy-ref.mjs) | `deploy:check-ref` | your deployment pipeline | refuses a deploy whose commit is not an ancestor of `main`. **No credentials** — pure git, and the first step of a deploy that can fail |
| [`assert-sdk-channel-alignment.mjs`](assert-sdk-channel-alignment.mjs) | `deploy:check-sdk-channel` | your deployment pipeline | does the dist-tag serving an environment resolve to a build of the commit that environment runs? Hard on `staging`, a warning on `dev`. Reads the registry, so it holds the publish role rather than the deploy role |

## Release — `release:`

| file | command | run by | what it does |
| :---- | :---- | :---- | :---- |
| [`resolve-release-channel.mjs`](resolve-release-channel.mjs) | `release:resolve-channel` | your release pipeline | the one place that decides what a git ref releases. Runnable locally with `--ref` |
| [`stamp-sdk-version.mjs`](stamp-sdk-version.mjs) | `release:stamp-version` | your release pipeline | **writes** the resolved version and commit into `clients/sdk/package.json`. CI's only real writer of a version |
| [`check-published-dist-tags.mjs`](check-published-dist-tags.mjs) | `release:check-dist-tags` | your release pipeline | the dist-tag this run wrote resolves to the version it published, and `latest` never holds a prerelease |
| [`check-sdk-pack-install.mjs`](check-sdk-pack-install.mjs) | `@scvs/sdk` `check:packaging` | `ci.yml`, your release pipeline | packs the SDK, installs the tarball outside the workspace, runs one aggregation through it |
| [`check-sdk-registry-install.mjs`](check-sdk-registry-install.mjs) | `@scvs/sdk` `check:registry-install` | your release pipeline | installs the SDK from the **registry** and asserts what a consumer can actually see |

## E2E harness — `e2e:`

Each needs a live environment and a run's artifacts, which is why none of them is a `check:`.

| file | command | run by |
| :---- | :---- | :---- |
| [`generate-e2e-ci-inventory.mjs`](generate-e2e-ci-inventory.mjs) | `e2e:generate-inventory` | the E2E harness |
| [`check-e2e-fixture-inventory.mjs`](check-e2e-fixture-inventory.mjs) | `e2e:check-fixtures` | the E2E harness |
| [`generate-e2e-upgrade-inventory.mjs`](generate-e2e-upgrade-inventory.mjs) | `e2e:generate-upgrade-inventory` | `run-upgrade-normal-lifecycle.sh` |
| [`check-e2e-upgrade-inventory.mjs`](check-e2e-upgrade-inventory.mjs) | `e2e:check-upgrade-fixtures` | `run-upgrade-normal-lifecycle.sh` |
| [`write-e2e-summary.mjs`](write-e2e-summary.mjs) | `e2e:summary` | `run-e2e-test.mjs`, `run-smoke.ts` |

## Libraries

No shebang, no script name, read or imported by the tools above.

| file | imported by | what it is |
| :---- | :---- | :---- |
| [`internal-identifiers.json`](internal-identifiers.json) | `internal-identifiers.mjs` | the identifiers no entropy scanner recognises — an account id held as a SHA-256 rather than a literal, because this directory ships in the mirror — and the per-file baseline the scrub drains |
| [`internal-identifiers.mjs`](internal-identifiers.mjs) | `check-secrets.mjs` | the one copy of each identifier pattern, and the redaction that pairs with it — a rule the gate knows and the exporter does not is the hole the prototype export shipped nine resource ids through |
| [`env-manifest.mjs`](env-manifest.mjs) | the manifest readers | `config/env-manifest.yaml`'s reader and resolver |
| [`composition-pairs.mjs`](composition-pairs.mjs) | the composition gates | the `(cliver, rsver)` pairs worth composing, and why each is in the list |
| [`sdk-declaration-typecheck.mjs`](sdk-declaration-typecheck.mjs) | both SDK install gates | does an installed tree's declaration graph resolve for a consumer outside the workspace |
| [`release-channels.mjs`](release-channels.mjs) | the resolver and both deploy assertions | the channel table, which dist-tag serves which environment, the SDK surface, and the ancestor-of-`main` proof |
