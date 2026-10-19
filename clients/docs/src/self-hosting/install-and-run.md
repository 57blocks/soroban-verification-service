<script setup>
import { githubRepoUrl } from "../../../web/src/config/site.ts";
</script>

# Install and run

This page assumes the infrastructure in [Requirements](./requirements.md) exists. It covers the images,
the configuration, the database, starting everything, and checking it works.

## 1. Get the images

| Image | Runs |
| --- | --- |
| `sv-service` | `verification-svc`, `orchestrator-svc`, `query-svc` and the database migrations |
| `sv-web` | The console and this documentation |
| `sv-builder` | Builds, one image per architecture |
| `sv-composer` | Environment composition, `arm64` |

The project publishes these to the GitHub Container Registry for every commit to `main`, as
`ghcr.io/57blocks/sv-<name>:<commit>`, and the builder as `sv-builder:<commit>-amd64` and `-arm64`.
Use one commit's images together. The project's own deployment copies them into ECR and runs them from
there, so its infrastructure does not depend on GHCR being reachable.

To build them yourself, from a checkout of the
<a :href="githubRepoUrl">repository</a>, use the Dockerfiles in `docker/`. The service image includes
the Stellar CLI the services use for chain lookups: fetch and check it first with
`SCVS_CI_CACHE=off scripts/ci/fetch-or-build-stellar-cli.sh`.

The repository's deployment workflows in `.github/workflows/` copy the images into ECR, register the job
definitions, run the migrations and deploy, in the order below. They are written for the project's own
environments, so read them as the reference for doing the same with your own tools.

## 2. Configure

Every setting is in the [Configuration reference](./configuration.md). Set these in every deployment.
Several have defaults that suit only a development machine, and a service starts with them without
complaint: unset, `SCVS_PUBLISHER_STORAGE` writes results to the container's own disk, and
`SCVS_PUBLIC_RESULT_ROOT` points at `localhost`.

| For | Settings |
| --- | --- |
| Identity | `SCVS_VERIFIER_ID`, `SCVS_VERIFIER_DISPLAY_NAME`, `SCVS_VERIFIER_POLICY_ID`. Published with every result; choose them once |
| Result storage | `SCVS_PUBLISHER_STORAGE`, `SCVS_PUBLISHER_BUCKET`, and `SCVS_PUBLIC_RESULT_ROOT`, the HTTPS URL it is read from. `SCVS_R2_REGION`, which an AWS S3 bucket needs too. For R2, `SCVS_R2_ENDPOINT` or `SCVS_R2_ACCOUNT_ID`. On any backend but AWS S3, `SCVS_SINGLE_WRITER=true` |
| AWS | `AWS_REGION`, and the working bucket, `SCVS_STORAGE_BUCKET` |
| Builds | `SCVS_BATCH_JOB_QUEUE_ARN_AMD64`, `SCVS_BATCH_JOB_QUEUE_ARN_ARM64`, `SCVS_JOB_STATE_CHANGE_QUEUE_URL`, and the job definitions `SCVS_BATCH_JOB_DEFINITION_ARN_AMD64` and `_ARM64`, given as family names despite their names |
| Composition, to verify contracts without a recorded image | `SCVS_COMPOSER_JOB_QUEUE_ARN`, `SCVS_COMPOSER_JOB_DEFINITION_ARN`, a family name, and `SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI` |
| Chain access, for `mainnet` | `SCVS_MAINNET_RPC_URL` for the verifier, `STELLAR_RPC_URL_MAINNET` for an aggregator |
| Your terms | `SCVS_LEGAL_DOCUMENTS_SOURCE`; see [Provide your legal documents](./legal-documents.md) |
| Secrets | `SCVS_ABUSE_FINGERPRINT_KEY`, and the database credentials |

Your result root is your verifier's identity: aggregators and readers know you by it, so choose a URL you
can keep. Changing it later makes you a different verifier to everyone who reads you.

Each service reports at `GET /internal/config-contract` which settings it was given, with the values of
the few that are safe to show. Expose that route only internally, and compare it with what you meant to
set.

## 3. Database

Run the migrations before each deployment, from the `sv-service` image:

- the verifier's database, with the migrations in `packages/db`;
- for an aggregator, its database, with the migrations in `packages/db-query`, then the list loader,
  `./node_modules/.bin/tsx scripts/seed-tvl.ts` in the image's `/app`, which loads its **Trusted Verifiers List** from `SCVS_TRUSTED_VERIFIERS_SOURCE`, a file or an `https:`
  URL pinned by `SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256`. It adds and updates the verifiers the list names,
  and disables any it no longer names; see [Join an aggregator](./join-an-aggregator.md#running-an-aggregator).

## 4. Start the services

1. **Register the job definitions** for `composer` and for `builder`, one per architecture, with the
   images from step 1. The builder's definition has two containers and mounts the host's Docker socket;
   the repository's builder deployment workflow is the reference for its shape.
2. **Start** `verification-svc`, `orchestrator-svc` and `web`, and for an aggregator `query-svc`.

On its first start, `orchestrator-svc` publishes `verifier-manifest.json` and `policy.json` to your result
root, from its configuration. It publishes them again on every start.

## 5. Check it works

- **Health.** Each service answers `/health/ready`, which reports whether it can reach its database. The
  public routes `GET /api/verification/v1/health` and `GET /api/query/v1/health` answer through the load
  balancer, and `web` answers `/healthz`.
- **Routing.** From a checkout of the repository, check that each path reaches the right service:

  ```sh
  node eng-tools/assert-host-routing.mjs --origin https://verifier.example.org
  ```

  It also checks the aggregator's routes and the redirect from HTTP to HTTPS; without `query-svc`, expect
  the aggregator's checks to fail.

- **Your result root.** `https://<result root>/verifier-manifest.json` should name your verifier.
- **A real verification.** Submit a dry run of a contract you know builds, as in
  [Verify from CI](../developers/verify-from-ci.md), and follow it to `verified`. A dry run exercises
  everything up to the comparison. Publishing is tested by your first real verification: check that its
  result appears under your result root.

## Upgrading

Deploy a new version in this order:

1. **Migrations**, for each database.
2. **`composer`**, before the orchestrator that asks it for environments.
3. **`orchestrator-svc`**, with `verification-svc`, `query-svc` and `web`.
4. **`builder`.** A builder writes its results in a versioned format; deploy it only after an
   orchestrator that reads that version. The repository's workflows refuse the wrong order.

Every published report records the build environment it used, so do not delete old composed environment
images.

## Trying it locally

`docker/docker-compose.full-stack.yml` is meant to run the services, the console and a database on one
machine, for development. As it stands, its orchestrator needs further settings before it starts, and
builds need AWS Batch in any case, so a local stack cannot verify a contract. Use it for working on the
APIs and the console.
