/** A public, one- or two-sentence description of each configuration variable the reference lists. */
export const CONFIG_SUMMARIES: Record<string, string> = {
  AWS_REGION:
    "AWS region the services' AWS clients use, including the scratch-bucket client. If unset, that client falls back to a fixed region and fails only when it first reads or writes an object.",
  CORS_ORIGIN:
    "Allowed CORS origin that query-svc sends to browsers. The verification API always allows any origin, so this setting does not affect it.",
  NODE_ENV:
    "Runtime mode read by Node.js, the service framework and Prisma. Use `production` for any real deployment; `test` is meant for the test suites.",
  PORT:
    "TCP port the service's HTTP server listens on, set per service. It must match whatever routes traffic to the container or health-checks it.",
  POSTGRES_DB:
    "Name of the PostgreSQL database to connect to. query-svc uses its own database, separate from the verifier's.",
  POSTGRES_HOST:
    "Hostname of the PostgreSQL server, without a port (the port is POSTGRES_PORT). query-svc's value must point at its own database server, not the verifier's.",
  POSTGRES_PASSWORD:
    "Password for POSTGRES_USER. Inject it as a secret rather than a plaintext environment value.",
  POSTGRES_PORT:
    "TCP port of the PostgreSQL server. Set it explicitly: the default suits only the local development database, and a wrong port shows up as a connection timeout.",
  POSTGRES_SSL:
    "Set `true` to connect to PostgreSQL over TLS (encrypted, without certificate verification). A server that enforces TLS rejects a plain connection, which can surface as a misleading access-denied error.",
  POSTGRES_USER:
    "Database user to connect as. query-svc needs its own credentials, which must not be able to open the verifier's database.",
  SCVS_ABUSE_COUNTER_RETENTION_MS:
    "How long, in milliseconds, a rate-limit counter row is kept after its window ends before the sweep deletes it. It only needs to cover clock skew between instances.",
  SCVS_ABUSE_FAILOPEN_THRESHOLD:
    "Consecutive failed database rate-limit checks after which the guard stops admitting requests and answers 503 instead. `0` fails closed on the first failure; the count is kept per instance.",
  SCVS_ABUSE_FINGERPRINT_KEY:
    "Secret HMAC key used to fingerprint client addresses for rate limiting, so raw IP addresses are never stored. Generate a random value once and keep it identical across all instances.",
  SCVS_ABUSE_MAX_PER_WINDOW:
    "Requests per abuse window one client may make to `POST /v1/preflight`. Counted in the database, so the limit is shared across all instances.",
  SCVS_ABUSE_SWEEP_INTERVAL_MS:
    "How often, in milliseconds, expired rate-limit counter rows are deleted.",
  SCVS_ABUSE_WINDOW_MS:
    "Length, in milliseconds, of the fixed window in which the per-client abuse limits (SCVS_ABUSE_MAX_PER_WINDOW and its submit and stream counterparts) count requests.",
  SCVS_ACTIVE_JOB_DEDUP_STALE_MS:
    "How long, in milliseconds, an unfinished job makes new submissions for the same target answer \"already queued or running\". Raising it past the slowest realistic build lets a stuck job block its target.",
  SCVS_AGGREGATION_SYNC_INTERVAL_MS:
    "How often, in milliseconds, query-svc refreshes its aggregated data from each trusted verifier. `0` disables the timer, and the aggregated bulk-load route then answers 503.",
  SCVS_ARCHIVE_RECOVERY_INTERVAL_MS:
    "How often, in milliseconds, the orchestrator retries pending Arweave archive uploads. Archiving has no attempt limit; a stuck archive is retried until it succeeds.",
  SCVS_ARTIFACT_DIR:
    "Writable scratch directory for temporary working files, such as `stellar` CLI working directories and the builder's and composer's per-job scratch space.",
  SCVS_ARWEAVE_GATEWAY_URL:
    "Arweave gateway base URL used to build links to archived reports and sources. Devnet uploads are reachable only through the Irys gateway, whatever this is set to.",
  SCVS_ARWEAVE_MODE:
    "Whether verification reports are also archived to Arweave: `disabled`, `dry-run` (records a placeholder transaction id without uploading) or `irys` (real uploads through Irys). Startup rejects any other value.",
  SCVS_ARWEAVE_NETWORK:
    "Irys network archives are uploaded to: `devnet` (free, not durable) or `mainnet` (paid, permanent). A deployment that needs durable archives must set `mainnet` explicitly.",
  SCVS_ARWEAVE_RPC_URL:
    "Ethereum RPC endpoint the archiving wallet signs Irys payments through. Needed on `mainnet`; `devnet` has a built-in endpoint.",
  SCVS_ARWEAVE_WALLET_PRIVATE_KEY:
    "Private key of the Ethereum wallet that pays for Irys uploads when SCVS_ARWEAVE_MODE is `irys`. Inject it as a secret.",
  SCVS_BATCH_DEFAULT_ARCH:
    "Which builder queue (`arm64` or `amd64`) runs a build image published for both architectures, or one whose architecture cannot be determined. Single-architecture images always go to the matching queue.",
  SCVS_BATCH_JOB_DEFINITION_ARN_AMD64:
    "AWS Batch job definition for builder jobs on the amd64 queue, given as a bare family name so Batch uses its latest active revision. If missing, amd64 builds fail as misconfigured rather than retrying.",
  SCVS_BATCH_JOB_DEFINITION_ARN_ARM64:
    "AWS Batch job definition for builder jobs on the arm64 queue, given as a bare family name so Batch uses its latest active revision. Use a separate family for each deployment.",
  SCVS_BATCH_JOB_QUEUE_ARN_AMD64:
    "ARN of the AWS Batch job queue that runs amd64 (x86) builds; its compute environment must be x86 only. There is no fallback to the arm64 queue when this is unset.",
  SCVS_BATCH_JOB_QUEUE_ARN_ARM64:
    "ARN of the AWS Batch job queue that runs arm64 builds; its compute environment must be arm64 only. There is no fallback to the amd64 queue when this is unset.",
  SCVS_BATCH_MATERIALISE_CONTAINER_NAME:
    "Name of the builder job definition's container that fetches and unpacks source without Docker access. It must exactly match the container name in the job definition, or that container receives no job parameters.",
  SCVS_BATCH_RUNNER_CONTAINER_NAME:
    "Name of the builder job definition's container that holds the Docker socket and runs the build. It must exactly match the container name in the job definition.",
  SCVS_BUILD_LOG_RETENTION_MS:
    "How long, in milliseconds, a job's raw build log stays available after its build finished before it is deleted. Expiry is also checked on every read, so lowering it takes effect immediately.",
  SCVS_BUILD_LOG_SWEEP_BATCH_SIZE:
    "Most expired build-log objects one sweep run deletes.",
  SCVS_BUILD_LOG_SWEEP_INTERVAL_MS:
    "How often, in milliseconds, expired build logs are deleted.",
  SCVS_BULK_PAGE_LIMIT:
    "Records requested per page when reading a peer verifier's bulk-load stream, from 1 to 200. Lower it to reduce the size of each request to peers.",
  SCVS_CLI_TIMEOUT_MS:
    "Time limit, in milliseconds, for one `stellar` CLI invocation. The builder reads it separately for its build and verify commands, with its own default.",
  SCVS_COMPONENT_FETCH_TIMEOUT_MS:
    "Time limit, in milliseconds, for each toolchain download the composer makes, and for the smoke test of a composed image.",
  SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI:
    "Private ECR repository URI, without tag or digest, that composed build environments are pushed to and pulled from. Give it no lifecycle expiry rule: a deleted image makes published results unreproducible.",
  SCVS_COMPOSER_BUILD_TIMEOUT_MS:
    "Time limit, in milliseconds, for the composer's `docker build` of one environment image. The AWS Batch job definition's own attempt timeout still applies.",
  SCVS_COMPOSER_DOCKER_HOST:
    "Docker daemon address the composer's `docker` commands use, passed to them as DOCKER_HOST. Kept separate from the builder's setting so the two fleets never share a daemon.",
  SCVS_COMPOSER_JOB_DEFINITION_ARN:
    "AWS Batch job definition for composer jobs, which build the environment images that legacy-CLI targets are verified in. Given as a bare family name, one per deployment.",
  SCVS_COMPOSER_JOB_QUEUE_ARN:
    "ARN of the AWS Batch job queue for composer jobs. Keep it separate from the builder queues so the two fleets never share a host; if unset, the first job needing a composed environment fails.",
  SCVS_COMPOSER_PARAMS_JSON:
    "The composer job's parameters, set per job by orchestrator-svc when it submits the job. Do not set it in the job definition.",
  SCVS_COMPOSER_TEMPLATE_DIR:
    "Directory inside the composer image that holds the composition templates. Override it only if the image places them elsewhere.",
  SCVS_DB_CONNECTION_TIMEOUT_MS:
    "How long, in milliseconds, a query waits to acquire a connection from the pool before failing.",
  SCVS_DB_IDLE_TIMEOUT_MS:
    "How long, in milliseconds, an idle pooled database connection is kept before it is closed. Unset uses the PostgreSQL driver's own default.",
  SCVS_DB_POOL_MAX:
    "Most database connections each process's pool opens. Unset uses the PostgreSQL driver's own default.",
  SCVS_DEPENDENCY_PREFETCH_TIMEOUT_MS:
    "Time limit, in milliseconds, for the builder's dependency prefetch (`cargo vendor`) step.",
  SCVS_DOCKER_CHECK_TIMEOUT_MS:
    "Time limit, in milliseconds, for the builder's quick Docker checks: that the daemon answers, and which options a build image supports.",
  SCVS_DOCKER_CPUS:
    "CPU limit for the build container, passed to `docker run --cpus`. An empty value removes the limit.",
  SCVS_DOCKER_HOST:
    "Intended Docker daemon address for the builder's sandbox runs. This release accepts the value but does not apply it, so the builder uses Docker's own DOCKER_HOST setting.",
  SCVS_DOCKER_MEMORY:
    "Memory limit for the build container, passed to `docker run --memory` (for example `4g`). An empty value removes the limit.",
  SCVS_DOCKER_PIDS_LIMIT:
    "Most processes the build container may run at once, passed to `docker run --pids-limit`. An empty value removes the limit.",
  SCVS_DOCKER_USER:
    "User and group (`uid:gid`) the build container runs as. Never set it to root (`0:0`).",
  SCVS_DRAIN_GRACE_MS:
    "How long, in milliseconds, a service keeps serving after SIGTERM while reporting not ready, so the load balancer can stop routing to it. Must exceed the deregistration delay plus one health-check interval.",
  SCVS_ENABLE_AGGREGATOR:
    "`true` makes the web console's aggregated query page at `/query` reachable; unset or `false` redirects it. Applied when the container starts, so one image serves either setting; any other value is refused.",
  SCVS_ENVIRONMENT_COMPOSE_TIMEOUT_MS:
    "How long, in milliseconds, an environment may stay `composing` before the reconciler checks its Batch job. Keep it well below the 30-minute private-upload lifetime, or submissions waiting on a lost composition fail.",
  SCVS_ENVIRONMENT_RECONCILER_INTERVAL_MS:
    "How often, in milliseconds, the reconciler checks environments that are still `composing`.",
  SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS:
    "Idle timeout, in milliseconds, of the load balancer or proxy in front of the service, used to check SCVS_KEEPALIVE_TIMEOUT_MS at startup. Set `0` when nothing fronts the server to skip the check.",
  SCVS_HANDOFF_ROOT:
    "Directory the builder's two containers share: one writes the extracted source there and the other hands it to Docker. It must be a host bind mount at the same path in both, not a Docker volume.",
  SCVS_HEADERS_TIMEOUT_MS:
    "How long, in milliseconds, a client has to finish sending request headers. Node enforces it on a periodic sweep, so a stalled request can outlive it by up to 30 seconds.",
  SCVS_JOB_MAX_WAIT_MS:
    "Age, in milliseconds, after which a job's status stream reports `job_timeout` instead of asking the client to reconnect.",
  SCVS_JOB_PARAMS_JSON:
    "The build job's parameters, set per job by orchestrator-svc when SCVS_JOB_PARAMS_TRANSPORT is `env_json`. Do not set it in the job definition.",
  SCVS_JOB_PARAMS_TRANSPORT:
    "How orchestrator-svc hands parameters to builder jobs: `env_json` inline, or `presigned_url` through the scratch bucket. Use `presigned_url`; inline parameters can exceed AWS Batch's override size limit, and such jobs are refused.",
  SCVS_JOB_PARAMS_URL:
    "A presigned URL to the build job's parameters, set per job by orchestrator-svc when SCVS_JOB_PARAMS_TRANSPORT is `presigned_url`. Do not set it in the job definition.",
  SCVS_JOB_RETENTION_BATCH_SIZE:
    "Most job rows one retention sweep run deletes.",
  SCVS_JOB_RETENTION_MS:
    "How long, in milliseconds, a job that never published a result is kept before it is deleted with its build log and related records. Published jobs are never deleted, whatever this value.",
  SCVS_JOB_RETENTION_SWEEP_INTERVAL_MS:
    "How often, in milliseconds, the job retention sweep runs.",
  SCVS_JOB_RETRY_INTERVAL_MS:
    "How often, in milliseconds, the orchestrator looks for failed jobs eligible for automatic retry. It does not change which jobs are eligible.",
  SCVS_JOB_STATE_CHANGE_QUEUE_URL:
    "URL of the SQS queue that receives AWS Batch job state-change events. Without it the service starts healthy but never sees a build finish; nothing else may consume this queue.",
  SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_IP:
    "Most job status streams one client address may hold open at once, across all jobs. Enforced per instance.",
  SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_JOB:
    "Most job status streams that may be open at once for a single job. Enforced per instance, so the effective limit grows with the number of instances.",
  SCVS_JOB_STREAM_MAX_CONNECTIONS_TOTAL:
    "Most job status streams one instance holds open at once, across all jobs and clients.",
  SCVS_JOB_STREAM_SAFETY_POLL_MS:
    "How often, in milliseconds, an open job status stream re-sends the job's current status. Keep it well below the idle timeout of any proxy or load balancer in front, or streams are cut mid-job.",
  SCVS_JOB_STREAM_WINDOW_MS:
    "How long, in milliseconds, one job status stream stays open before it ends with `stream_timeout` so the client reconnects.",
  SCVS_KEEPALIVE_TIMEOUT_MS:
    "How long, in milliseconds, the HTTP server keeps an idle connection open for reuse. Must exceed SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS, or the proxy may reuse a closed connection and answer 502; startup refuses the inversion.",
  SCVS_LEGAL_DOCUMENTS_SOURCE:
    "The Terms of Service and Privacy Notice bundle shown to submitters: a file path, an `https:` URL, or the JSON bundle inline. The shipped sample has no effective date, so terms are not enforced until you supply your own.",
  SCVS_MAINNET_RPC_URL:
    "Soroban RPC endpoint the `stellar` CLI uses for mainnet lookups, also passed to build jobs. Needed to serve mainnet; its host and path can appear in published build logs, so keep credentials out of the path.",
  SCVS_MAX_JOB_RETRY_ATTEMPTS:
    "How many times a job is automatically re-queued after a retryable failure, such as a build timeout, before it stays failed. `0` disables automatic retries.",
  SCVS_MAX_PUBLISH_ATTEMPTS:
    "How many failed attempts to publish one verdict are made before the recovery scan gives up on it.",
  SCVS_MAX_REBUILT_WASM_BYTES:
    "Largest rebuilt Wasm file, in bytes, the orchestrator downloads and hashes to reach a verdict. A larger build fails as `rebuilt_bytes_too_large`; raising the limit raises the memory one rebuild can use.",
  SCVS_MAX_SOURCE_ARCHIVE_BYTES:
    "Largest compressed source archive accepted, in bytes. verification-svc applies it to uploads and the builder to the archive it downloads.",
  SCVS_MAX_SOURCE_ARCHIVE_ENTRIES:
    "Most entries a source archive may contain; the builder checks this before extracting it.",
  SCVS_MAX_SOURCE_ARCHIVE_UNCOMPRESSED_BYTES:
    "Largest total size, in bytes, a source archive may expand to, checked from its listing before extraction.",
  SCVS_POLICY_ACCEPTED_TRUST_LEVELS:
    "Comma-separated build-image trust levels the published verifier policy declares as accepted. It describes the policy rather than changing enforcement; change SCVS_VERIFIER_POLICY_ID with it.",
  SCVS_POLICY_ARBITRARY_IMAGES_ALLOWED:
    "Declares in the published verifier policy whether submitters may use arbitrary build images of their own. It does not change enforcement; change SCVS_VERIFIER_POLICY_ID with it.",
  SCVS_POLICY_DIGEST_PINNED_ONLY:
    "Declares in the published verifier policy whether build images must be pinned by digest. It does not change enforcement; change SCVS_VERIFIER_POLICY_ID with it.",
  SCVS_POLICY_REQUIRE_TARBALL_SHA256:
    "Declares in the published verifier policy whether private source uploads require a matching tarball SHA-256. It does not change enforcement; change SCVS_VERIFIER_POLICY_ID with it.",
  SCVS_POLICY_RETAIN_ARTIFACTS:
    "Declares in the published verifier policy whether this verifier retains its result artifacts. It does not change enforcement; change SCVS_VERIFIER_POLICY_ID with it.",
  SCVS_POLICY_TAG_ONLY_ALLOWED:
    "Declares in the published verifier policy whether build images referenced only by tag are accepted. It does not change enforcement; change SCVS_VERIFIER_POLICY_ID with it.",
  SCVS_PREFETCH_ALLOWED_HOSTS:
    "Comma-separated hosts the builder's dependency prefetch may download from. Setting it replaces the built-in list of common Rust crate and Git hosts.",
  SCVS_PUBLIC_RESULT_ROOT:
    "Public base URL published results are served from, written into every published artifact. Choose its final value before publishing anything: published artifacts keep the old URL, and other verifiers may already have copied them.",
  SCVS_PUBLISHER_BUCKET:
    "Bucket that holds the published results tree and nothing else, since everything in it is served publicly. Use one per deployment, separate from SCVS_STORAGE_BUCKET.",
  SCVS_PUBLISHER_PREFIX:
    "Key prefix for published results inside SCVS_PUBLISHER_BUCKET; published URLs do not include it. Leave it empty for a bucket dedicated to results, or the URLs under SCVS_PUBLIC_RESULT_ROOT stop resolving.",
  SCVS_PUBLISHER_STORAGE:
    "Where published results are written: `filesystem`, `s3` (AWS S3) or `r2` (Cloudflare R2). Unset writes to the container's local disk without any error, so set it for any container deployment.",
  SCVS_PUBLISH_RECOVERY_INTERVAL_MS:
    "How often, in milliseconds, the orchestrator retries pending result and source publications.",
  SCVS_PUBLISH_STALE_MS:
    "How long, in milliseconds, a job may stay `publishing` before its worker is presumed dead and the publication is retried. Too low a value can produce two reports for one verdict.",
  SCVS_QUERY_ADDRESS_THROTTLE_LIMIT:
    "Requests per minute per client each process accepts on the contract-address lookup route, which makes one Soroban RPC call per request. Must be below SCVS_QUERY_THROTTLE_LIMIT; changing it needs a restart.",
  SCVS_QUERY_CACHE_TTL_MS:
    "A cache lifetime in milliseconds that query-svc accepts and validates. No code in this release reads it, so it currently has no effect.",
  SCVS_QUERY_PIN_DNS_RESOLUTION:
    "Whether requests to peer verifiers connect to the DNS answer that was validated, closing a DNS-rebinding gap. Leave it enabled; disabling it exists only for test doubles.",
  SCVS_QUERY_THROTTLE_LIMIT:
    "Requests per minute per client per route each query-svc process accepts. It must stay above SCVS_QUERY_ADDRESS_THROTTLE_LIMIT.",
  SCVS_QUERY_TIMEOUT_MS:
    "Time limit, in milliseconds, for each request query-svc makes to a trusted verifier.",
  SCVS_R2_ACCOUNT_ID:
    "Cloudflare account ID, used to derive the R2 endpoint when SCVS_R2_ENDPOINT is unset.",
  SCVS_R2_ENDPOINT:
    "Custom S3-compatible endpoint URL for the results bucket, such as a Cloudflare R2 endpoint. Leave it unset for AWS S3.",
  SCVS_R2_REGION:
    "Region passed to the storage client for any non-filesystem results backend, despite its name. Set it to the bucket's region on AWS S3, which rejects the default.",
  SCVS_READINESS_DB_TIMEOUT_MS:
    "How long, in milliseconds, `/health/ready` waits for the database before reporting it unreachable. Keep it below the load balancer's health-check timeout.",
  SCVS_READ_THROTTLE_LIMIT:
    "Requests per 60-second window per client per route each process accepts on the public read routes (bulk load and Wasm status), replacing SCVS_THROTTLE_LIMIT there. Changing it needs a restart.",
  SCVS_REBUILD_DISPATCH_TIMEOUT_MS:
    "How long, in milliseconds, a rebuild may stay mid-submission to AWS Batch before it is dispatched again.",
  SCVS_REBUILD_REAPER_INTERVAL_MS:
    "How often, in milliseconds, the rebuild reconciler checks for stalled dispatches and long-running rebuilds.",
  SCVS_REBUILD_RUN_TIMEOUT_MS:
    "How long, in milliseconds, a rebuild may run before the reconciler asks AWS Batch for its status. It never stops a job Batch still reports as running.",
  SCVS_REPORT_ARCHIVE_CLAIM_TIMEOUT_MS:
    "How long, in milliseconds, a claimed report archive upload may stay unfinished before another worker treats it as abandoned and takes it over. Keep it longer than a normal upload takes.",
  SCVS_REQUEST_TIMEOUT_MS:
    "How long, in milliseconds, a whole request may take, from its first byte to the end of the response. It also bounds how long a slow upload can hold its buffered body.",
  SCVS_RESULT_ROOT:
    "Local directory published results are written to when SCVS_PUBLISHER_STORAGE is `filesystem`; other backends ignore it.",
  SCVS_RPC_TIMEOUT_MS:
    "Time limit, in milliseconds, for each Soroban RPC call query-svc makes to resolve a contract address.",
  SCVS_SINGLE_WRITER:
    "Set `true` to state that exactly one orchestrator writes to the result store. Required to start on backends without cross-process conditional writes, such as `filesystem`, since the service cannot count its replicas.",
  SCVS_SOURCE_ARCHIVE_CLAIM_TIMEOUT_MS:
    "How long, in milliseconds, a claimed source archive upload may stay unfinished before another worker treats it as abandoned and takes it over. Keep it longer than a normal upload takes.",
  SCVS_SOURCE_ARCHIVE_ENABLED:
    "Set `true` to also archive published public mainnet source code to Arweave, alongside the report archive. Requires SCVS_ARWEAVE_MODE `irys`.",
  SCVS_SOURCE_FETCH_TIMEOUT_MS:
    "Time limit, in milliseconds, for the builder to download a job's source archive.",
  SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS:
    "How long, in milliseconds, an expired upload is still kept while a public job referencing it has not yet published its source. Read by verification-svc and orchestrator-svc; give both the same value.",
  SCVS_STATUS_LINK_RECOVERY_INTERVAL_MS:
    "How often, in milliseconds, the orchestrator retries adding Arweave archive links to published Wasm status documents.",
  SCVS_STORAGE_BUCKET:
    "S3 bucket used as private scratch space for staged build inputs and private source uploads, reached only through presigned URLs. verification-svc checks it only at the first upload; orchestrator-svc fails at startup without it.",
  SCVS_STREAM_ABUSE_MAX_PER_WINDOW:
    "Job status streams (`GET /v1/verifications/:id/events`) one client may open per abuse window. It limits how fast streams are opened, not how many stay open.",
  SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW:
    "Requests per abuse window one client may make to each of `POST /v1/verifications` and `POST /v1/uploads/source`, counted per route and shared across instances. This is usually the limit a submitter reaches first.",
  SCVS_TAR_TIMEOUT_MS:
    "Time limit, in milliseconds, for each `tar` command the builder runs when checking and unpacking a source archive.",
  SCVS_THROTTLE_LIMIT:
    "Requests per 60-second window per client per route each process accepts on routes without their own limit. Keep it above the abuse limits, which are shared across instances and should stay the binding policy.",
  SCVS_TRUSTED_VERIFIERS_SOURCE:
    "The trusted verifiers list the database seed step loads: a file path or an `https:` URL. Set it explicitly; the default is a local-development list whose entries query-svc cannot use.",
  SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256:
    "Hex SHA-256 of the trusted verifiers list, required when SCVS_TRUSTED_VERIFIERS_SOURCE is an `https:` URL; the seed refuses to run without it. Ignored for a file path.",
  SCVS_UPLOAD_CLEANUP_INTERVAL_MS:
    "How often, in milliseconds, expired private source uploads are deleted.",
  SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE:
    "Requests per minute per client each process accepts on `POST /v1/uploads/source`, replacing SCVS_THROTTLE_LIMIT there. Changing it needs a restart.",
  SCVS_VERIFIER_DISPLAY_NAME:
    "Human-readable name of this verifier, published with its results and shown by consumers for attribution.",
  SCVS_VERIFIER_ID:
    "Stable identifier this verifier publishes its results under. Set it before the first publication: artifacts already published keep the identity they were written with.",
  SCVS_VERIFIER_POLICY_ID:
    "Identifier of the verifier policy this deployment publishes, cited by every artifact. Change it whenever any SCVS_POLICY_* value changes, so artifacts never cite a policy that says something else.",
  SCVS_WORKER_CONCURRENCY:
    "How many jobs the orchestrator advances at once, up to 8. Raise it when verifications routinely overlap.",
  SCVS_WORKER_CONCURRENCY_TESTNET:
    "Most of the SCVS_WORKER_CONCURRENCY slots testnet jobs may use at once; mainnet jobs can use any free slot.",
  SCVS_WORKER_POLL_INTERVAL_MS:
    "How often, in milliseconds, the orchestrator looks for jobs ready to dispatch.",
  SERVICE_ENTRYPOINT:
    "Which service the shared service image starts: `verification-svc`, `orchestrator-svc` or `query-svc`. A wrong value starts a different service that still reports healthy.",
  STELLAR_CLI_PATH:
    "Path to the `stellar` CLI binary. The service image ships one; set this only to use a binary elsewhere.",
  STELLAR_RPC_URL_MAINNET:
    "Soroban RPC endpoint query-svc uses to resolve mainnet contract addresses. Without it, mainnet address lookups fail at request time; use the same endpoint as SCVS_MAINNET_RPC_URL.",
  STELLAR_RPC_URL_TESTNET:
    "Soroban RPC endpoint query-svc uses to resolve testnet contract addresses.",
  VITE_ENABLE_AGGREGATOR:
    "Local-development counterpart of SCVS_ENABLE_AGGREGATOR, read when the console runs without its container. Do not set it when building an image for deployment.",
  VITE_QUERY_API_URL:
    "Base URL the console's query page uses to reach query-svc, fixed at build time. Empty means same origin, which is correct when one host routes both the console and the APIs.",
  VITE_VERIFY_API_URL:
    "Base URL the console uses to reach the verification API, fixed at build time. Set the empty string for same-origin routing; leaving it unset makes the console show a configuration error.",
};
