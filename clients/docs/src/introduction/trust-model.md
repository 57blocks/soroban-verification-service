# Trust model

Every result is one verifier's answer, published under that verifier's identity. Nothing here claims to
be the network's verdict.

## Verifiers speak for themselves

A **verifier** is an identity that rebuilds contracts and publishes what it found. Its identity is its
**result root**, the HTTPS URL its results are published under; a display name is only what the
verifier calls itself. Anyone can run a verifier, and each deployment of this software is one verifier,
not a shared platform.

A verifier running this software publishes two documents about itself at its result root:

| Document | Answers |
| --- | --- |
| `verifier-manifest.json` | Who published these results |
| `policy.json` | What this verifier will and will not verify |

Because verifiers run different policies, they can reach different results for the same Wasm. A
contract verified by one verifier and rejected by another is not unverified: it is verified under one
policy and not under the other. Attribution keeps both signals visible.

A verifier keeps one current result per Wasm hash. A later `verified` replaces an earlier one, but a
`mismatched` never replaces an existing `verified`.

## Aggregators collect, they do not decide

An **aggregator** reads several verifiers and returns each one's entry for a Wasm hash, side by side.
It does not vote, rank, merge, or pick a winner. Its responses carry an `agreement` field, such as
`unanimous_verified` or `disputed`, that describes the entries; it is a summary, not a verdict. If your
application needs a single yes or no, the rule that produces it is yours to choose, based on which
verifiers you trust.

Which verifiers an aggregator reads is set by its operator in a **Trusted Verifiers List**:

- Each member has a `status` — `active`, `paused` or `disabled` — and may carry a `trust_tier`, the
  operator's own free-form assessment.
- Paused and disabled members stay listed rather than disappearing.
- A verifier cannot add itself to anyone's list or set its own tier. There is no registration API.

When an aggregator's latest read of a listed verifier failed, it names that verifier in
`unavailable_verifiers` and keeps serving the entries it last retrieved, rather than leaving the
verifier out.

## What each result tells you about itself

Two fields on every published result describe how much weight it can carry. They are independent of
each other.

**`recipe_source`** — where the build instructions came from.

| Value | Meaning |
| --- | --- |
| `on_chain_metadata` | Recorded in the deployed contract's own build metadata |
| `submitted` | Supplied with the verification request |

**`image_trust_level`** — how the build environment came about.

| Value | Meaning |
| --- | --- |
| `official_trusted` | An image the official Stellar pipeline publishes |
| `upstream_pinned` | Composed by the verifier from pinned official components |
| `publicly_auditable` | Digest-pinned, with a public reproducible definition |
| `arbitrary` | Digest-pinned, provenance not established |

This software publishes only the first two. It grants `official_trusted` to an image from the official
`stellar/stellar-cli` repository, pinned by digest, and `upstream_pinned` to an environment it composed.

## What you can check without trusting anyone

- **Results are static files keyed by hash.** A verifier's result for a Wasm hash sits at a path anyone
  can derive and read over HTTPS, with no account and no client library.
- **Reports never change.** A report is stored under its own SHA-256, and the status object that points
  to it carries that hash, so you can confirm the bytes you read are the bytes that were published.
- **An archived copy is the same bytes.** Where a verifier archives a report to Arweave, the archived
  copy hashes to the same SHA-256 as the HTTPS copy.
