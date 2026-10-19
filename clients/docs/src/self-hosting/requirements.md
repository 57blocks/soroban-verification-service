# Requirements

What to provision before you install. Names of resources are up to you; the services learn them from
their [configuration](./configuration.md). Give every resource that belongs to one environment the
environment's name, so two environments can never share a bucket or a queue by accident.

## The long-running services

`verification-svc`, `orchestrator-svc` and, for an aggregator, `query-svc` run from one image, chosen by
`SERVICE_ENTRYPOINT`. `web` has its own image. Any container platform works. The published images of both
are `arm64`; for `amd64`, build them yourself.

- **`verification-svc`** and **`query-svc`** listen for HTTP. Put them behind a load balancer that
  terminates HTTPS and routes by path:

  | Path | To |
  | --- | --- |
  | `/api/verification/*` | `verification-svc` |
  | `/api/query/*` | `query-svc` |
  | any other `/api/` path | a `404`, from the load balancer |
  | everything else | `web` |

  The `web` container serves the console and this documentation, and proxies nothing.
- **Idle timeout.** The load balancer's idle timeout must exceed the interval at which a job's event
  stream sends an update, `SCVS_JOB_STREAM_SAFETY_POLL_MS`, 10 seconds by default. Tell the services the
  load balancer's idle timeout in `SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS`, 60 seconds by default: each service
  refuses to start unless its keep-alive timeout, `SCVS_KEEPALIVE_TIMEOUT_MS`, is longer.
- **`orchestrator-svc`** listens on loopback only, for its health check. It needs no inbound traffic.

## Builds: AWS Batch

`builder` and `composer` run as AWS Batch jobs, on **EC2** compute environments. Each job starts its
sandbox container through the host's Docker daemon, so the job definition mounts the host's Docker
socket; Fargate cannot run them.

- **One builder queue and job definition per CPU architecture**, `amd64` and `arm64`, each backed by a
  compute environment of that architecture only. A build runs on the architecture of its build image,
  with no fallback, so a missing queue fails every build that needs it.
- **One composer queue and job definition**, on `arm64`: composed build environments are `arm64`
  images.
- **Job-state events.** An EventBridge rule sends Batch job-state changes for these queues to an
  **SQS queue** that only `orchestrator-svc` reads. The orchestrator does not start without the queue.
  Without the rule, it learns that a build finished only when it next asks Batch, minutes later.

The builder's job definition has two containers, one that prepares the source and one that runs the
build, sharing a working directory. The repository's builder deployment workflow registers it, and is
the reference for its shape.

## Storage

| What | Kind | Access |
| --- | --- | --- |
| **Working bucket** | S3 | Private. Holds uploads and each build's inputs and outputs. Read and written by `verification-svc` and `orchestrator-svc`; jobs get time-limited links only |
| **Result storage** | S3, Cloudflare R2 or another S3-compatible store; or a directory, for a single orchestrator process, which `verification-svc` mounts too | Read and written by `orchestrator-svc`, read by `verification-svc`, and **readable by anyone over HTTPS** at a stable URL: your result root. Serving it is up to you, such as through a CDN; no service serves it |
| **Composed environments** | ECR repository | Written by `composer`, read by `builder`. Give it no expiry rule: published results name these images |

Several orchestrator processes can share result storage only on AWS S3 itself, which supports the
conditional writes they rely on. On any other backend, run one orchestrator and set
`SCVS_SINGLE_WRITER=true`.

## Databases

PostgreSQL, through Prisma.

- **The verifier's database**, used by `verification-svc` and `orchestrator-svc`.
- **The aggregator's database**, used only by `query-svc`, with its own credentials. It must not be able
  to reach the verifier's database.

## Network

| Component | Needs to reach |
| --- | --- |
| `orchestrator-svc` | Stellar RPC for each network it verifies; the URLs submitters give for their source; container registries, to read build images; AWS Batch, SQS and S3; result storage; Irys and an Ethereum RPC, if it archives to Arweave |
| `verification-svc` | Stellar RPC; S3; result storage; the URL of your legal documents, if they are given as one |
| `builder` | S3, through the links it is given; Docker Hub, for official Stellar CLI images; ECR; public package hosts, such as crates.io and the main Git hosts, to download dependencies |
| `composer` | The official sources of its components, such as Docker Hub, GitHub releases and the Rust toolchain servers; ECR; S3, through the link it is given |
| `query-svc` | The result roots of the verifiers it reads; Stellar RPC, to resolve contract addresses |

`mainnet` has no default RPC endpoint: set one to verify `mainnet` contracts.

**Keep the build machines apart.** Run `builder` and `composer` on networks separate from the services
and the databases, and separate from each other: `composer` holds the right to push images that later
builds run, and a build runs untrusted code.

## Credentials

What each component may do, and nothing more:

| Component | Allowed |
| --- | --- |
| `builder` | Pull from ECR, including the composed-environments repository; write logs. **No other AWS access**, no database, no result storage |
| `composer` | Push to and pull from the composed-environments repository; write logs. No database and no buckets |
| `orchestrator-svc` | Submit and describe Batch jobs; read and delete SQS messages; read, write and delete in the working bucket; read and write result storage |
| `verification-svc` | Read, write and delete in the working bucket; read result storage |
| `query-svc` | None beyond its own database |

Configure each job definition by its family name, so every job uses the latest revision; the
orchestrator's permission to submit jobs then has to allow both a definition's unversioned and versioned
ARNs.

## Secrets and required settings

Secrets:

- `SCVS_ABUSE_FINGERPRINT_KEY`: a random 256-bit key for rate limiting. `verification-svc` does not start
  without it.
- Database credentials, for each database.
- `SCVS_R2_ACCESS_KEY_ID` and `SCVS_R2_SECRET_ACCESS_KEY`, for R2 or another S3-compatible store.
- `SCVS_ARWEAVE_WALLET_PRIVATE_KEY`, only if you archive results to Arweave.

Keep secrets apart from ordinary settings, so that permission to read configuration never grants access
to a password or a key.

Settings without which a service does not start: `SCVS_LEGAL_DOCUMENTS_SOURCE` for `verification-svc`
(see [Provide your legal documents](./legal-documents.md)); `SCVS_JOB_STATE_CHANGE_QUEUE_URL` and
`SCVS_STORAGE_BUCKET` for `orchestrator-svc`; `SCVS_PUBLISHER_BUCKET` for result storage on S3 or R2; and
`SCVS_SINGLE_WRITER=true` on any backend but AWS S3.

Some required settings fall back to values that suit only a development machine, and a service starts
with them: `SCVS_VERIFIER_ID`, `SCVS_PUBLISHER_STORAGE`, `SCVS_PUBLIC_RESULT_ROOT`, and `SCVS_R2_REGION`,
whose default AWS S3 rejects. Set them explicitly. [Install and run](./install-and-run.md#_2-configure)
lists what every deployment sets, and the [Configuration reference](./configuration.md) every setting.
