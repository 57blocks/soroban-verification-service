# FAQ

## About verification

### Does "verified" mean a contract is safe?

No. It means a verifier rebuilt the published source and got exactly the bytes deployed on chain, so the
source you can read is the code that runs. Whether that code is correct, or safe to use, is a separate
question that verification does not answer.

### Who decides whether a contract is verified?

Each verifier, for itself. A result always names the verifier that reached it, and verifiers can run
different policies and reach different results. No result is the network's verdict. See
[Trust model](../introduction/trust-model.md).

### My contract was upgraded. Is it still verified?

An upgrade deploys a new Wasm, and results belong to a Wasm, not to an address. The new Wasm has no result
until someone verifies it. Looking the contract up by address always answers for the Wasm it runs now.

### Which networks are supported?

`mainnet` and `testnet`.

## Submitting

### Do I need an account, or to pay?

No. Submitting and reading need no account and no key. Rate limits stand in for authentication.

### Can I verify a contract I did not deploy?

Yes. Anyone who has the exact source can submit any deployed contract. The result is about the source and
the Wasm, not about who submitted them.

### Why can't my contract be verified?

Usually because its Wasm does not record enough about how it was built. Check it in the
[console](../developers/use-the-console.md), which tells you why; [Supported contracts](../introduction/supported-contracts.md)
explains each case. To make future versions verifiable, see
[Make your contract verifiable](../developers/make-your-contract-verifiable.md).

### Can I try it without publishing anything?

Yes, with a dry run through the API: the job builds and compares, and the result goes back only to you.
The console cannot submit one. See [Verify from CI](../developers/verify-from-ci.md#try-it-first-with-a-dry-run).

### How long does it take?

Usually a few minutes; longer the first time a verifier composes a build environment for a contract
without a recorded image.

### I got a mismatch. What now?

The rebuild worked but produced different bytes, most often because the archive or the build options are
not the ones the contract was built with. See
[Troubleshoot a failed verification](../developers/troubleshoot.md#a-mismatch).

### Can someone undo my verified result by submitting the wrong source?

No. A verifier never replaces its own `verified` result with a later mismatch.

## Your source and your data

### Do I have to publish my source?

No. By default the verifier publishes only the archive's hash, plus its URL if you gave one. An uploaded
archive is deleted once no job needs it. Publishing the source is a stronger claim, because anyone can
then repeat the rebuild. See [Public or private](../developers/prepare-your-source.md#public-or-private).

### Who can read my build log?

Only whoever holds the token returned when the job was submitted. The log is redacted of credentials and
local paths, and deleted after a retention period, seven days by default.

### Can a published result or source be removed?

Not through the service: it has no way to withdraw a result or a source that was published. Reports are
written to never change, and a copy archived to Arweave's main network is permanent. See
[Data and retention](../legal/data-and-retention.md). If you need something removed, ask
the verifier's operator; see [Support](./support.md).

### What happens to the jobs I submit?

A job that failed, a dry run, and any other job that did not change a published status object are
deleted after 30 days by default. A job behind a published result is kept.

## Reading results

### How do I show verification status in my application?

Query an aggregator, then apply your own rule about which verifiers you trust. See
[Choose an interface](../integrators/choose-an-interface.md) and
[Interpret multi-verifier results](../integrators/interpret-multi-verifier-results.md).

### Is there an SDK?

A TypeScript SDK for reading results exists, and will be published to npm when the project's repository
becomes public. Until then, the HTTP APIs and the result files serve every language.

### Can I check a result without trusting the verifier?

In part. A report is stored under its own SHA-256, so you can confirm you hold what was published. If the
source is public, you can repeat the rebuild yourself; see
[Troubleshoot a failed verification](../developers/troubleshoot.md#reproduce-the-rebuild-yourself).

## Running a verifier

### Can I run my own verifier?

Yes. The software is open source under the Apache License 2.0, and each deployment is its own verifier,
publishing under its own identity. Guides for running one will be published here.
