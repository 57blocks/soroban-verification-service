<script setup>
import { githubRepoUrl } from "../../../web/src/config/site.ts";
</script>

# Run your own verifier

Anyone can run this software. Each deployment is its own **verifier**: it rebuilds contracts under its
own policy and publishes results under its own identity, its result root. Running one adds an
independent voice to the ecosystem; it does not join a shared platform.

You can also run an **aggregator**, which reads several verifiers' results and serves them through the
Query API, with or without a verifier of your own.

## What a verifier runs

| Component | What it does | Exposed |
| --- | --- | --- |
| `verification-svc` | The Submission API: preflight, uploads, submissions, job status, events and build logs; this verifier's published results and its legal documents | Publicly, under `/api/verification/` |
| `orchestrator-svc` | Runs jobs: resolves source, dispatches builds, compares, publishes | No |
| `builder` | Rebuilds one contract in its sandbox. Runs as a batch job | No |
| `composer` | Composes a build environment for a contract without a recorded image. Runs as a batch job | No |
| `web` | The console and this documentation | Publicly, at `/` |
| `db-migrate` | Applies database migrations before each deployment | No |

They share a PostgreSQL database, a private working bucket, and the **result storage** that holds what
the verifier publishes: a location served read-only over HTTPS.

`composer` is needed only to verify contracts that record their toolchain versions but no build image.
Without it, those contracts fail to verify; everything else works.

## What an aggregator runs

`query-svc` serves the Query API, under `/api/query/`, from its own PostgreSQL database. It reads each
verifier on its Trusted Verifiers List over HTTPS, and needs no other infrastructure. Its list is
loaded into its database; see [Install and run](./install-and-run.md#_3-database).

## What it depends on today

The software is written for one infrastructure shape, and this guide describes it:

- **Builds run on AWS Batch**, on EC2 instances with access to the Docker daemon, because each build
  starts its own sandbox container. Batch's job-state events reach the verifier through an SQS queue.
- **The working bucket is S3**, and composed build environments are stored in an ECR repository.
- **Result storage** can be S3, Cloudflare R2 or another S3-compatible store, or a local directory for a
  single-process setup.

There is no adapter for other batch systems, queues or buckets: running elsewhere means writing one. The
repository contains no infrastructure-as-code; the [requirements](./requirements.md) describe what to
provision, in whatever tool you use.

## What you take on

- **Your policy and your name.** Results you publish carry your verifier's identity. What your verifier
  accepts is set by its configuration, and published in its `policy.json`.
- **Your terms.** The verifier serves Terms of Service and a Privacy Notice you supply; see
  [Provide your legal documents](./legal-documents.md).
- **Running untrusted code safely.** The software isolates each build, but the machines, networks and
  credentials around it are yours to secure; see [Security model](../security/security-model.md).
- **Licensing.** The software is under the Apache License 2.0. If you redistribute it, include its
  <a :href="`${githubRepoUrl}/blob/main/LICENSE`">LICENSE</a> and
  <a :href="`${githubRepoUrl}/blob/main/NOTICE`">NOTICE</a>.

## Next

1. [Requirements](./requirements.md): what to provision.
2. [Install and run](./install-and-run.md): images, configuration, the database, and first checks.
3. [Configuration reference](./configuration.md): every setting.
4. [Join an aggregator](./join-an-aggregator.md): be read alongside other verifiers.
