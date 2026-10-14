# Supported contracts

Whether a contract can be verified, and how, depends on what its deployed Wasm records about its own
build. A Wasm never gains that record later, so a Wasm's class is fixed by how it was built. A contract
that is upgraded runs a new Wasm, which can fall in a different class.

Contracts on `mainnet` and `testnet` are supported.

## Where the record lives

The Stellar CLI and the Soroban SDK write key-value entries into custom sections of the Wasm called
`contractmetav0`; a Wasm can carry several. Two entries name the toolchain:

| Key | Records |
| --- | --- |
| `cliver` | The Stellar CLI version that built the contract, written by the CLI |
| `rsver` | The Rust compiler version |

[SEP-58](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0058.md) adds the entries
a rebuild needs to reproduce the build exactly, including:

| Key | Records |
| --- | --- |
| `bldimg` | The build image reference |
| `bldopt`, `bldarg` | The build options and arguments |
| `source_uri`, `source_sha256` | Where the source is, and the hash of the archive |

## The three classes

| Class | The Wasm records | The rebuild uses | You supply |
| --- | --- | --- | --- |
| **cli-58** | A complete SEP-58 recipe, including `bldimg` | The image named on chain | Nothing the contract already records |
| **cli-legacy** | `cliver` and `rsver`, but no `bldimg` | An environment the verifier composes from the official components for that pair | The source, and any build inputs the contract does not record |
| **cli-none** | Neither a build image nor both toolchain versions | — | Cannot be verified |

### cli-58

This verifier accepts a build image only when it is pinned by digest and comes from the official Stellar
CLI repository (`docker.io/stellar/stellar-cli@sha256:…`). An image named by a tag is rejected, because
a tag can point at different bytes tomorrow. Results for this class carry `image_trust_level:
official_trusted`, and `recipe_source: on_chain_metadata` when the rebuild uses the recorded options
unchanged; a submission that changes `bldopt` or `bldarg` is published as `submitted`.

### cli-legacy

A contract built with the Stellar CLI but without a SEP-58 recipe falls here. The verifier composes a
build environment from official sources only: a digest-pinned base image, a checksum-pinned rustup
installer that installs the exact Rust toolchain named by `rsver`, and the Stellar CLI release named by
`cliver`, checksum-verified against its GitHub release. No input from the submission goes into the
environment. Results carry `image_trust_level: upstream_pinned`.

A `mismatched` result is common in this class: the original build may have used an option or a
dependency version that the contract never recorded.

The pair is refused in cases including these:

- `rsver` names a nightly Rust toolchain without a date;
- `cliver` does not name a released Stellar CLI version;
- that Rust version does not distribute a build target the environment needs.

The first is caught by preflight. The others surface only after submission, when the job assembles
its build environment.

### cli-none

A contract that records neither a build image nor both toolchain versions gives the verifier nothing
to choose a build environment from, so this verifier does not accept it. That is a policy choice, not a
technical limit.

## Checking your contract

The quickest check is preflight: enter the contract in the web console, and it tells you whether the
contract can be verified and, if not, why, and prefills the inputs the contract records. You can also
read the record yourself with the Stellar CLI:

```sh
stellar contract info meta --wasm path/to/contract.wasm
```
