# Data and retention

This page describes what the verifier software does with the data a submission carries: what it records,
what it publishes, and how long it keeps each part. It describes the software at its default settings.
An operator can change those settings, and decides how its servers, logs and storage are run, so the
operator's <a href="/privacy">Privacy Notice</a> is what governs this verifier.

<LegalOperator />

## What a submission sends

| Data | Notes |
| --- | --- |
| The target: network, and contract ID or Wasm hash | Optionally the network passphrase too |
| The source: an uploaded archive, or a URL | With the archive's SHA-256 |
| The archive's file name | Sent with an upload by the console and the API client |
| Build options and arguments | |
| Whether the source is public | Private by default |
| Whether the job is a dry run | |
| The version of the terms you accept | Required once the operator's terms are in force |

Submitting needs no account. The software asks for no name, email address or other contact detail.

## What is recorded about you

- **Web server logs.** The web server that serves the console and this documentation keeps a standard
  access log, which records each request's IP address, browser details and the page asked for. Where
  that log goes, and how long it is kept, is up to the operator.
- **The API services' logs** record what the services did, such as job IDs, contract IDs, Wasm hashes
  and source hashes, and the reason a job failed, which can include the source URL. They do not record
  IP addresses, browser details or request bodies. Their retention, too, is up to the operator.
- **Rate limits** count requests per caller. The counts kept in the database are stored under a keyed
  one-way hash of the caller's address that changes every minute, and are deleted after about 15
  minutes. Other counts are held in memory for a minute or two, some under the address itself. The
  operator holds the key, so these counts are pseudonymous rather than anonymous.
- **A job records the submission**: the target, the manifest, including the source's hash and its URL
  or upload, the build options and whether the source is public, whether it is a dry run, when it was
  submitted and finished, and its result and diagnostics. If you named a version of the terms, the job
  records it with a hash of those terms. The build-log token returned to you is not stored, only a hash
  of it.
- **An upload records** the archive, its file name as sent, its size and its hash.

To run a build, the verifier passes the job's build parameters, including the source URL and the build
options, to the job-scheduling service of the infrastructure it runs on.

## What is published

A job that reaches a verdict, and is not a dry run, publishes two documents to the verifier's result
root, readable by anyone; see [Understand a result](../developers/understand-a-result.md). They contain:

- the Wasm hash, the verdict, the hash of the Wasm the rebuild produced, and when the verdict was reached;
- the build recipe: image, options and arguments;
- the source archive's SHA-256, and whether the source was declared public;
- **the source URL, if you gave one, whether or not you declared the source public**;
- the sandbox's diagnostics, including **excerpts of the build's output**. The software removes the
  credentials, tokens and local paths it recognises, but compiler output can quote lines of the source
  and paths inside it, and the excerpts are published whether or not the source is public.

If you declared the source public, the archive itself is published too, under its hash rather than its
original file name.

Nothing that identifies you is published: not your address, the job ID, or your acceptance of the terms.
A failed job and a dry run publish nothing.

### Copies on Arweave

If the operator turns on archiving, each published report is also uploaded to Arweave through Irys, a
third-party upload service, and, where the operator enables it, each public source on `mainnet`. Each
upload is tagged with the Wasm hash, the document's hash, its content type and the verifier's
identifier. A copy on Arweave's main network cannot be removed by anyone. The software's default target is
Irys's development network, which does not keep data permanently; the operator chooses the network.

## Who can see a job

- **Anyone with the job ID** can read its status: the target, its timing and progress, and its result,
  including the diagnostics and the build command the verifier ran, which contains the build options. A
  failure's detail can contain the source URL. For a published result, the status links the published
  report.
- **Only the holder of the build-log token** can read the build log.

## How long it is kept

| Data | Kept |
| --- | --- |
| Published reports and public source archives | Indefinitely. The software has no way to withdraw them |
| A verifier's status object for a Wasm | Until a later verdict for that Wasm replaces this verifier's entry; reports it pointed to remain |
| Copies on Arweave's main network | Permanently |
| A job behind a published result | For as long as the verifier runs |
| Any other job, including failed jobs and dry runs, with the terms version it recorded | 30 days |
| The build log, as you can read it | 7 days, or until you delete it with your token |
| An uploaded archive | Until its job ends, at most 30 minutes if it is unused. Some uploads are kept longer while a job still needs them, for at most 4 hours |
| The verifier's working copies for a build: a source fetched from a URL, an unwrapped archive, the rebuilt Wasm, and the build's record, which includes a copy of the build log | Not deleted by the software; as long as the operator's storage keeps them |
| Rate-limit counts in the database | About 15 minutes |
| An aggregator's copies of other verifiers' results | Until the verifier's own entry goes, or the aggregator's operator disables that verifier. A paused verifier's copies are kept |

The periods are the defaults; an operator can change them.

## Removing data

The software has no feature to withdraw a published result or a published source, and a copy on
Arweave's main network cannot be withdrawn by anyone. To ask for anything to be removed, contact the
operator, above.

## In your browser

The console sets no cookies, and loads no analytics or third-party scripts. It keeps in your browser's
local storage your eight most recent jobs, with their target, status and times; the last job you opened;
and the build-log tokens of jobs you submitted, which it clears out once they are 30 days old, the next
time it saves a token. This documentation keeps your colour scheme and search preferences there too.
Clearing your browser's site data removes all of it.
