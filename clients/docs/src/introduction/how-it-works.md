# How it works

A verification runs through four stages: **preflight**, **submit**, **rebuild**, then **compare and
publish**. The [web console](../quick-start/verify-in-the-console.md) walks you through all four. Preflight and submit are HTTP calls you can make
yourself, and you can follow the rest over HTTP; see the [API reference](../api/index.md).

## 1. Preflight

You name a deployed contract — a network (`mainnet` or `testnet`) and either a contract ID or a Wasm
hash. Preflight reads the deployed Wasm and its build metadata, and answers before any job exists:

- which build environment the contract records, and whether this verifier accepts it;
- which build inputs the contract already records, and which ones you still need to supply;
- a prefilled manifest you can submit as it is, or complete.

When preflight can tell that a contract cannot be verified, it says why. A few toolchain problems, such
as a recorded Stellar CLI version with no matching release, only surface once the job assembles its
build environment. Preflight never starts a build. See [Supported contracts](./supported-contracts.md)
for the cases.

## 2. Submit

A submission names the target and the source. If the verifier publishes Terms of Service that require
it, the submission also names the version you accepted, and the job records it. The source reaches
the verifier in one of two ways:

| Source | How | What happens to it |
| --- | --- | --- |
| At a public URL | You give the URL and the SHA-256 of the archive it serves | The verifier fetches it and checks the hash. The URL is published with the result; a copy is kept only if you declare the source public |
| On your machine | You upload the archive first, then reference the upload | Kept only if you declare it public; otherwise the upload is deleted once no job still needs it |

Either way, the archive is pinned by its SHA-256 before anything runs. A request that is wrong on its
face — a malformed hash, an unknown network — is rejected immediately, and no job is created. Working
copies in the verifier's staging storage expire under that storage's own retention policy.

You can also submit a **dry run**: the verifier builds and compares as usual, returns the result to
you, and publishes nothing.

## 3. Rebuild

Every rebuild runs in a fresh sandbox, in two stages:

1. **Fetch.** With network access limited to an allowlist, the sandbox downloads the dependencies and
   toolchain components the build needs.
2. **Build.** With no network at all, it runs the build.

The build environment is the one the deployed Wasm records: either a digest-pinned official Stellar
CLI image, or an environment the verifier composes from the official components that the Wasm's
recorded toolchain versions name.

The rebuild replays the recipe's build options and arguments — recorded on chain, or supplied with the
submission when the contract records none — and the contract's recorded metadata. The verifier adds
only a fixed set of operational settings, such as file locations and offline, locked dependency use,
each tested not to change the output bytes.

The sandbox holds no database access and no credentials. Source code can run arbitrary code at build
time, through build scripts and procedural macros, so the sandbox is built on the assumption that it
will.

A job whose recipe exactly matches an earlier rebuild reuses that rebuild's output. The comparison is
always done again.

## 4. Compare and publish

Outside the sandbox, the verifier hashes the rebuilt Wasm and compares it with the deployed Wasm. A
completed comparison is published to the verifier's **result root**, a set of static documents served
over HTTPS:

- a **status object** for the Wasm hash, holding this verifier's current result for it;
- a **report**, which records the recipe, the build image, the source hash and the comparison. A report
  is content-addressed and never changes once written.

If the verifier archives its results, the report is then uploaded to Arweave and the archive's location
is added to the status object. HTTPS stays the primary way to read a result; a permanent archive copy
is the one that outlives it.

## Following a job

A job's progress is available as it happens, as a [server-sent event stream](../api/events.md), or by
polling its status.
When a build ran, its log — redacted of credentials and local paths — is available to the submitter
for every outcome, failures included. Reading it takes the build-log token returned at submission, and
the log is kept for a limited period: seven days unless the verifier configures otherwise.
