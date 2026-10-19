# Security model

A verifier's job is to run code it does not trust. A submitted contract's build scripts and procedural
macros run during the build, and can do anything the build environment lets them. So the build is
treated as hostile, and the system is arranged so that a hostile build cannot reach anything worth
having, or make the verifier publish a result it did not earn.

This page describes what the software enforces. Some protections, such as how the operator's network and
machines are set up, are the operator's to provide; see [What the operator provides](#what-the-operator-provides).

## The build sandbox

Every rebuild runs in fresh containers, sharing no files or cache with earlier builds. It happens in two
stages:

1. **Download.** The dependencies named in `Cargo.lock` are downloaded into a separate directory. This
   step has network access. Before and after it, the verifier checks every dependency source the
   archive names against an allowlist of public package hosts, such as crates.io and the main Git hosts,
   and refuses private and local addresses named there.
2. **Build.** The build container has **no network** at all. By default, it:
   - runs as an unprivileged user, with every Linux capability dropped and privilege escalation disabled;
   - has a read-only filesystem, apart from its output and temporary directories;
   - reads the source and the downloaded dependencies from read-only mounts;
   - is limited in CPU, memory and number of processes.

A build that runs past its time limit fails. An operator can change these settings; the defaults are the
ones described here.

### What the build can reach

Nothing of value. The process that runs builds holds no database access, no credentials for result
storage, and no keys for publishing anything. It receives the source through a short-lived link to that
one archive, and returns its output the same way. Escaping the container yields no credential for the
database, the result storage or publishing, so an attacker cannot change published results that way.

### Who chooses the build environment

Never the submitter. The build image comes from the deployed Wasm's own metadata: either the official
Stellar CLI image, pinned by digest, that the contract records, or an environment the verifier composes
from the official components for the toolchain versions the contract records. Composition runs in a
separate job that is given only those versions, never anything from the submission. See
[Supported contracts](../introduction/supported-contracts.md).

## Trusting the output

A build can print anything, including a fake report of what it built. The verifier ignores such claims:

- The build must write its Wasm to a dedicated location; the verifier takes the file from there, not
  from anything the build prints.
- The verifier fetches the deployed Wasm from the ledger itself, and computes both hashes outside the
  sandbox. The verdict is reached there, never inside the build.

## Your source

- **It is pinned before anything runs.** The archive is checked against its SHA-256, and against the
  hash the contract records on chain, if any, before a build starts.
- **Archives are checked before they are unpacked**: no absolute paths or paths that climb out, no
  links or special files, and limits on entry count and unpacked size.
- **A source URL is fetched by the verifier, not by the build**: over HTTPS only, never from a private or
  local address. Git URLs are not accepted, because Git's transports cannot be confined the same way.
- **Private source is not published.** For an archive you do not declare public, the result publishes
  its hash, and its URL if you gave one, but not the archive. An upload is deleted once no job still
  needs it; a copy the verifier made of a source fetched from a URL stays in its working storage for as
  long as the operator's storage settings keep it. See
  [Public or private](../developers/prepare-your-source.md#public-or-private).
- **The build log is private.** Compiler output can contain fragments of source, so the log is redacted
  of credentials and local paths, readable only with the token returned to the submitter, and deleted
  after a retention period, seven days by default.

Do not put secrets in a source archive, public or private: the build runs whatever the source contains.

## Results you read

- **Every result is attributed** to the verifier that published it; no result speaks for the network.
- **Reports cannot change after publication.** A report is stored under the SHA-256 of its own bytes,
  and the status object gives that hash beside its link, so you can check you hold what was published.
  An archived copy on Arweave has the same hash.
- **A verified result is not undone by a later mismatch.** Submitting the wrong source for a verified
  Wasm cannot replace that verifier's `verified`.
- **A public source can be rebuilt by anyone**, so a result does not have to be taken on trust.

See [Trust model](../introduction/trust-model.md) for what a result does and does not claim.

## The public API

There are no accounts, so there is nothing to steal or reuse. Each caller is rate-limited on every route
that does work, with tighter limits on submitting, uploading and looking up contracts; health checks, a
job's status, and an event stream once it is open are not limited. Uploads and downloads have size
limits. See [Rate limits](../api/index.md#rate-limits).

## What the operator provides

The software cannot enforce how it is deployed. An operator is responsible for, among other things:

- running builds on machines and networks separate from the services, the database, and environment
  composition, which holds the right to push build images to the verifier's registry;
- the operating system and container runtime the sandbox relies on;
- who can read and write the result storage, and the keys for archiving to Arweave;
- keeping the deployment up to date.

<LegalOperator />

## Reporting a problem

If you find a way around any of this, report it privately; see
[Report a vulnerability](./report-a-vulnerability.md).
