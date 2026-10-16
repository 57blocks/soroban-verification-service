# Use the console

The console is two pages: <a href="/verify">/verify</a>, where you check and submit a contract, and
`/verify/jobs/<job_id>`, where a job reports its progress and result. This page explains each part of
both. For a first walkthrough, see [Verify a contract in the console](../quick-start/verify-in-the-console.md).

The console cannot submit a dry run. To try a contract without publishing anything, use the API; see
[Verify from CI](./verify-from-ci.md#try-it-first-with-a-dry-run).

## Naming the contract

Choose the network, then name the contract by its **Contract ID** or by its **Wasm hash**. A result
belongs to a Wasm, so the two lead to the same verification; use the Wasm hash when you have the Wasm
but not a deployed address. Either way, the network is required.

Changing the network, the contract or the choice between them clears the check and anything you filled
in after it.

## The check

**Check this contract** runs preflight: it reads the deployed Wasm and its metadata, and submits nothing.
The answer is one of these banners:

| Banner | Means |
| --- | --- |
| **This contract can be verified** | This verifier can rebuild it with the build image the Wasm names, or will try to compose an environment from its recorded toolchain versions. The form below opens |
| **This contract cannot be verified** | The recorded toolchain cannot be reproduced: an undated nightly Rust, or no toolchain record at all |
| **This contract cannot be verified yet** | The Wasm names a build image, pinned by digest, that this verifier does not accept |
| **Rejected by verification policy** | The Wasm names a build image by tag rather than by digest |
| **Could not check this contract** | The verifier did not give an answer: it could not be reached, it is rate-limiting you, or it found no such contract on that network. The message under the title says which |

The first four are properties of the deployed Wasm; nothing you submit changes them. Some toolchains
are found to be impossible to compose only once the job runs, such as a Stellar CLI version that was
never released; the job then ends `policy_rejected`.
[Supported contracts](../introduction/supported-contracts.md) explains why.

## Completing the evidence

**Available metadata** lists what the Wasm records about its build. The fields below it are filled in
from it, and from preflight's suggested manifest:

| Field | Notes |
| --- | --- |
| **Source SHA-256** | Required. Filled in when the contract records it. Picking an archive to upload fills it in from the file |
| **Build arguments** | Leave empty for the default, `contract build` |
| **Build options** | Separated by spaces, each written `--flag` or `--flag=value` |
| **Source access** | **Public URI**: a link to the archive's bytes. **Upload archive**: a file from your machine |
| **Publish this source publicly** | Off by default. See [Public or private](./prepare-your-source.md#public-or-private) |

### Build options the console refuses

Before anything is sent, the console checks each option can be replayed. It refuses, and says why:

- a short flag such as `-p`, or a value separated by a space instead of `=`;
- `--offline`, `--config`, `--env`, `--target-dir` and `--out-dir`, which change the build environment
  rather than the build, and are set by the verifier;
- a `--manifest-path` without `=path`, or with a path that is absolute or climbs out of the archive.

### Uploading an archive

When you pick a file, the console reads and hashes it in your browser. It refuses a file that is not a
gzip tarball or a zip, whatever its name, and asks you to compress an uncompressed tar first. If the
contract records a `source_sha256` and your file hashes to something else, the console says so at once;
that archive cannot verify this contract. The file is uploaded only when you submit.

### The terms

The submit button needs the box accepting the verifier's <a href="/terms">Terms of Service</a> and
acknowledging its <a href="/privacy">Privacy Notice</a>. The box stays disabled while the terms load, and
if they cannot be loaded, nothing can be submitted until they can. The console submits the version of
the terms it showed you.

## After you submit

The console opens the job's page and follows the job there as it runs. If the same Wasm and archive
are already queued or running, you are taken to that job instead of a new one, and its build log stays
with whoever submitted it first.

Leaving the page does not stop the job. Come back to it from **Recent verification jobs** on the console,
or through the job link.

## The job page

- **Current job** shows the job ID. **Copy job link** copies the page's address; anyone with it can
  follow the job and read the result.
- **Build timing** runs from when the verifier accepted the submission, so it includes time spent waiting
  for a build slot. When a job did not record when it finished, the total is shown as an upper bound.
- The **progress steps** mark how far the job has got.
- The **banner** gives the outcome: **Verification passed**, **Verification mismatch**, or the reason
  the job stopped, such as **Build failed** or **Source unavailable**, with the verifier's own detail
  and code. [Troubleshoot a failed verification](./troubleshoot.md) goes through each.

**How this was rebuilt** appears for a published result. It shows the recipe the verifier used: source
hash, build image, Stellar CLI and Rust versions, build options and arguments, and the manifest path.
Values marked **on-chain** were read from the contract's metadata, so a submitter could not choose them.
The console shows it once it has fetched the published report.

**Verification result** appears once the job has an outcome. For a published result it links the report
and the status object; see [Understand a result](./understand-a-result.md). For a failure it gives the
reason and what to check. On a mismatch it adds the rebuilt Wasm's hash, the likely causes, and a
comparison of the two Wasm files.

**Developer diagnostics** holds the build command the verifier ran, the comparison as JSON, and
everything the sandbox reported. It opens by itself on any outcome other than a pass.

## The build log

The build log is the compiler's output. It can hold paths and fragments of source, so it is not public:
it answers only to the token the verifier returned when the job was created. The console keeps that
token in the browser you submitted from, and shows the log, with routine lines folded, and the token
itself, under **Build log**.

| What you see | Why |
| --- | --- |
| The log | You submitted the job from this browser |
| "The raw build log is not part of this page" | You did not submit it, or not from this browser. Ask the submitter |
| "No build was started for this job" | The job stopped before building; the reason follows |
| "The raw build log has passed its retention period" | Logs are deleted after a retention period, seven days by default. The result is unaffected |
| "This job's build log could not be read" | A fault on the verifier's side. Try again shortly |

Copy the token if you will need the log from another browser or a script; the verifier never issues it
again.

## What the console keeps in your browser

- **Recent verification jobs**: the last eight jobs you submitted or opened, with their status.
- **Build-log tokens**: kept for thirty days.

Both live in the browser's local storage, so clearing site data, or a private window, loses them. The
jobs and their results are unaffected; only your shortcut to them, and your access to the logs, is lost.
