# ADR-023: The project is licensed Apache-2.0

> **Status**: Proposed (drafted 2026-09-02) — drafted by an agent recording a decision taken by
> 57Blocks, awaiting a human signature per `../../AI_COLLAB.md`'s role table
> ("may draft and propose; never adopts unilaterally"). **Do not merge unsigned.**
> **Scope**: the licence the repository is distributed under, and the copyright notice every
> user-facing surface shows. Not the hosted service's terms, which are a separate document served at
> `/terms` — and, since the versioned-terms work, **operator configuration rather than anything this
> repository ships**, so the separation this line draws is now structural rather than editorial.
> **Evidence**: `../evidence/2026-09-02-dependency-licence-scan.md`
> — 1078 packages, zero copyleft: no dependency's licence obstructs the choice.

## Context

The TRD states the licence as a disjunction: **"Apache-2.0 or MIT"** (`../trd/TRD.md`
§ header table, and the openness row of §9.1's non-functional table, mirrored in
`../design/operations.md` and `qa/cases/E2E-SDK.md`). It comes from the
RFP's openness requirement, which accepts either. Nothing ever picked one.

The repository behaved as though nothing had, and drifted into stating three different answers at once:

| Surface | Said |
| --- | --- |
| `LICENSE` (repository root) | MIT, Copyright 2026 57Blocks |
| `clients/sdk/package.json` | `"license": "Apache-2.0"` |
| Landing page footer, capabilities card, self-host card | "Apache-2.0 / MIT" |
| Every other `package.json` (16 of them) | no `license` field |

That is not a cosmetic inconsistency. The published SDK bundle declares one licence to npm tooling
while the file it ships beside declares another, and a self-hoster reading the footer is told a dual
licence that no `LICENSE` file grants. The disjunction had to collapse to one answer before the soft
launch put those surfaces in front of anyone.

## Decision

**The project is licensed under the Apache License, Version 2.0.** One licence, not a dual grant.

- `LICENSE` carries the full Apache-2.0 text with 57Blocks' copyright in the appendix boilerplate.
- `NOTICE` accompanies it, as Apache-2.0 §4(d) provides for.
- The root `package.json` declares `"license": "Apache-2.0"`; `clients/sdk` already did and is now
  consistent with the file beside it rather than contradicting it.
- Every user-facing surface naming the licence says Apache-2.0 and nothing else.

**The TRD does not change.** "Apache-2.0 or MIT" is a requirement this satisfies, not a statement
this contradicts — choosing one arm of a permitted disjunction is conformance, and rewriting the
requirement to match the choice would destroy the record that either was acceptable. The same
applies to `docs/design/operations.md` and `docs/qa/cases/E2E-SDK.md`, which restate it.

## Why Apache-2.0 rather than MIT

Both satisfy the RFP, and both are permissive. Three things separate them here, all of which point
the same way for **infrastructure that produces trust claims other parties act on**:

1. **An express patent grant and its defensive termination (§3).** MIT grants copyright permission
   and is silent on patents. This service's whole output is a public assertion about someone else's
   deployed contract; adopters — StellarExpert and other consumers of the Registry API among them —
   integrate it into products. An express grant, terminating for anyone who initiates patent
   litigation over the work, is worth more to those adopters than to us, and costs us nothing we
   were trying to keep.
2. **§5 makes inbound contributions match the outbound licence by default.** Contributions are
   licensed under the same terms unless the contributor says otherwise, so the project needs no CLA
   and no DCO bot to accept an outside pull request. The proposal commits to a community-operable,
   independently-operable verifier; that commitment implies outside contributors, and MIT leaves
   their inbound terms to be inferred.
3. **§4's attribution and NOTICE mechanics fit redistribution.** This is distributed as container
   images and a Helm chart that others deploy under their own identity. Apache-2.0 says explicitly
   what a redistributor must carry and what they may add on top; MIT's single sentence leaves it to
   convention.

Apache-2.0 is also what the surrounding ecosystem uses — the Stellar SDKs and `stellar-cli` — so a
contributor moving between them meets no new terms.

## Consequences

- **Downstream is unaffected in practice.** MIT is compatible with Apache-2.0 in the direction that
  matters: anything already taken under MIT stays usable under MIT forever. The change binds new
  copies only. Nobody loses a permission they had.
- **Relicensing is 57Blocks' to do.** Every commit in the history is authored by a
  `@57blocks.com` address (12 identities, all employees), so the copyright is single-holder and no
  outside contributor consent is required. This is the one fact that makes the change cheap, and it
  stops being true the day the first outside pull request merges — after that, §5 handles new
  contributions but a *further* relicence would need their agreement.
- **Per-file SPDX headers are not added.** The repository has never carried licence headers and
  Apache-2.0 does not require them; a header on every source file would be a large diff for no legal
  effect. `LICENSE` plus `NOTICE` at the root is the whole obligation.
- **The 15 remaining private packages keep no `license` field.** They are `private: true`, never
  published, and never distributed except as part of the repository the root `LICENSE` covers.
  Adding a field to each would be a claim about artifacts that do not exist.

## Alternatives rejected

- **Keep MIT.** Would have been the smaller diff, and resolves the inconsistency just as well. Loses
  the patent grant and the §5 inbound rule, both of which this project's adopter- and
  contributor-facing posture actually uses. Nothing about MIT's brevity is a benefit here.
- **Dual-license Apache-2.0 OR MIT** — the Rust ecosystem's convention, and literally what the
  footer already claimed. Rejected: a dual grant is a real thing to maintain (both files, both
  declared everywhere, every contribution licensed under both) and it exists to solve a
  compatibility problem this project does not have. The footer's "Apache-2.0 / MIT" was a
  transcription of the TRD's disjunction, not a considered dual grant.
- **Defer until legal review of the ToS.** Rejected: the two are independent. The ToS
  governs the hosted service and needs counsel; the code licence is a standard, unmodified OSI
  licence over code 57Blocks wholly owns. Holding it would leave three contradictory statements
  live through the soft launch.
