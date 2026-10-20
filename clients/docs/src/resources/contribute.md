<script setup>
import { githubRepoUrl } from "../../../web/src/config/site.ts";
</script>

# Contribute

The verifier, the aggregator, the console, the SDK and this documentation are open source, under the
Apache License 2.0. The source is on GitHub, at <a :href="githubRepoUrl">{{ githubRepoUrl }}</a>,
and development happens there in the open.

## What the repository holds

| Directory | Holds |
| --- | --- |
| `services/` | The services: `verification-svc` (the Submission API), `orchestrator-svc` (runs the builds), `builder` and `composer` (the build jobs), and `query-svc` (an aggregator's Query API, deployed apart from a verifier) |
| `clients/` | The console (`web`), the SDK (`sdk`), this site (`docs`), and the Submission API client the console uses (`api-client`) |
| `packages/` | Code the services share, such as the result format and the fetch policy |
| `docs/results-sep/` | The result format: the two [specification](../specifications/verification-results.md) drafts, their JSON Schemas and examples |
| `config/` | The environment manifest that the [configuration reference](../self-hosting/configuration.md) is generated from, and example files |

<a :href="`${githubRepoUrl}/blob/main/ARCHITECTURE.md`">ARCHITECTURE.md</a> describes how the parts fit
together.

## Report a bug or ask for a feature

Open an <a :href="`${githubRepoUrl}/issues/new/choose`">issue</a>, using the bug report or the feature
request form. Issues are the project's public tracker. For a bug, include the steps to reproduce it and,
for a job, its `job_id`.

**Never report a vulnerability in an issue or a pull request**: both are public, and a pull request that
fixes a vulnerability discloses it. See [Report a vulnerability](../security/report-a-vulnerability.md).

A problem with a verifier someone runs, rather than with the software, goes to that verifier's operator;
see [Support](./support.md).

## Build from source

The repository is a pnpm workspace. You need Node.js 20 or later (CI uses Node.js 24), pnpm, Git,
and Docker for the local database.

```sh
git clone https://github.com/57blocks/soroban-verification-service.git
cd soroban-verification-service
pnpm install
pnpm run generate:api-client
pnpm run build
```

From there, the README's
<a :href="`${githubRepoUrl}#quick-start-from-zero`">Quick Start From Zero</a> starts the database and
each service. Running a build needs more than your machine: the orchestrator always sends builds to the
cloud, so verifying a contract locally needs the infrastructure described in
[Requirements](../self-hosting/requirements.md).

The SDK and this site need none of that:

```sh
pnpm --filter soroban-verification-client run test   # the SDK's own tests
pnpm run generate:openapi && pnpm run dev:docs        # this site, at http://localhost:5180/docs/
```

## Open a pull request

Read <a :href="`${githubRepoUrl}/blob/main/CONTRIBUTING.md`">CONTRIBUTING.md</a> first. In short:

- **Run the baseline checks first**: `pnpm run build`, `pnpm run typecheck`, `pnpm run lint` and
  `pnpm run test`; `test` needs the local database, migrated with `pnpm run db:migrate`. CI runs these
  and the repository's other checks. It needs no secrets and no cloud account, so a pull request from a
  fork runs the same checks as a maintainer's.
- **A first-time contributor's checks can wait for a maintainer** to approve the run. Deployment and
  end-to-end tests do not run on pull requests.
- **Keep the documentation in the same pull request.** A change to what users see, or to what a
  deployment has to provide, updates the page that describes it.
- **Fill in the template's four sections**: summary, test plan, architecture impact, and security and
  data handling impact. "None" is a valid answer for the last two.
- **Changes that touch the build sandbox** or the boundary around it need a reading of
  <a :href="`${githubRepoUrl}/blob/main/SECURITY.md`">SECURITY.md</a> first.

## Licensing your contribution

There is no contributor license agreement and no sign-off. Unless you say otherwise in the pull
request, what you submit is licensed under the Apache License 2.0, as section 5 of the license provides.
See [Open-source licenses](../legal/open-source-licenses.md) for the license and its notices.

## Code of conduct

The project follows the Contributor Covenant; read the
<a :href="`${githubRepoUrl}/blob/main/CODE_OF_CONDUCT.md`">code of conduct</a>. Report a concern to
<a href="mailto:opensource@57blocks.com">opensource@57blocks.com</a>.

## Releases

The SDK, the public HTTP APIs and the result format are versioned together, and each release is listed
in the [changelog](./changelog.md) and on the repository's
<a :href="`${githubRepoUrl}/releases`">releases</a> page. A release tag publishes the SDK to npm; see
[Use the SDK](../integrators/use-the-sdk.md#install) for its channels. The services themselves are not
released: their images are built from every commit to `main`.
