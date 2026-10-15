# What is contract verification?

A Soroban contract lives on the Stellar network as a Wasm binary. The network stores those bytes, not
the source code they came from. Contract verification answers one question about them:

> Does this source, built the way the contract says it was built, produce exactly the bytes that are
> deployed?

## What "verified" means here

The verifier rebuilds the submitted source in an isolated sandbox, using the build environment that the
deployed Wasm itself records. Outside the sandbox, it hashes the rebuilt Wasm and compares it with the
deployed Wasm byte for byte.

| Result | Meaning |
| --- | --- |
| `verified` | The rebuilt Wasm is identical to the deployed Wasm. |
| `mismatched` | The comparison ran, and the two differ. |

These are the only two verdicts a verifier ever writes to its published results. Any other outcome —
the source could not be fetched, the build failed, the contract records nothing to rebuild from — is
reported back to the submitter, with the build log when a build ran, and is never published as a claim
about the contract. While a verification is queued or running, a verifier's API can answer for that
Wasm hash with `unverified`; that is a progress state, not a verdict.

## What it does not mean

- **It is not an audit.** A `verified` result says the source and the bytes correspond. It says nothing
  about whether the code is correct, safe, or does what its authors intended.
- **It is not a network-wide verdict.** Each result is one verifier's answer, published under that
  verifier's identity. Different verifiers can run different policies and reach different results; see
  [Trust model](./trust-model.md).
- **It belongs to a Wasm hash, not a contract address.** A contract that is upgraded runs a new Wasm,
  and that Wasm needs its own verification.
- **`mismatched` is not an accusation.** It is a completed comparison whose bytes differ. It is the
  expected result for many older contracts, whose builds did not record everything a rebuild needs.

## Who uses it

| You are | You want to | Start with |
| --- | --- | --- |
| A contract developer | Prove that your deployed contract matches your source | [How it works](./how-it-works.md), then [Supported contracts](./supported-contracts.md) |
| An integrator — a wallet, an explorer, an indexer | Show users whether a contract's source is verified, and by whom | [Trust model](./trust-model.md) |
| A verifier operator | Run your own verifier and publish your own results | [Trust model](./trust-model.md) |
