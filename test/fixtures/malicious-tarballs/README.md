# Malicious Tarball Fixtures

**Populated 2026-08-14 — but not here, and that is the decision this file now records.**
This is also the precedent the `test/` workspace-membership decision
generalizes: a suite belongs inside the workspace package that exercises it, not under repo-level `test/`.

The corpus lives at
[`services/builder/test/malicious-corpus.ts`](../../../services/builder/test/malicious-corpus.ts),
driven by
[`malicious-corpus.spec.ts`](../../../services/builder/test/malicious-corpus.spec.ts). Every archive is
**built at test time from code**, not checked in as a binary.

## Why no binaries

The original instruction here was that "deliberately crafting malicious binary fixtures is a separate,
deliberate task". It was, and the deliberate part turned out to be the shape rather than the content:

- **A checked-in archive is opaque.** A reviewer cannot see what `traversal.tar.gz` contains without
  unpacking it, and a diff against one is unreadable. The attack should be legible in the source.
- **A repository that ships archives designed to escape an extraction root is itself a small hazard** —
  to anyone who clones it and runs a careless `tar -xf`, and to any scanner that flags the repo.
- **Several of these cannot be produced by `tar` at all.** GNU tar strips a leading `../` at create
  time while bsdtar keeps it, so a tar-built traversal fixture tests the local tar rather than our
  validator, and asserts a different reason code per platform. The corpus writes ustar headers directly
  for exactly those cases, which is only possible in code.

## What it covers

Path traversal (parent, deep, absolute, and one hidden among conformant members), symlink escape
(absolute and relative), hard-link escape, a non-file entry type, an entry-count bomb, and an
uncompressed-expansion bomb. Each entry names the reason code the extractor owes it, and the suite
asserts **both** that the archive is refused for that reason **and** that nothing was written to the
destination — a refusal that left a half-extracted tree behind would pass the first assertion with the
control already gone.

One conformant archive goes through the same call, so the corpus cannot pass by an extractor that
refuses everything.

## Related, and deliberately elsewhere

- **T13's planted-artifact half** — a `build.rs` writing a Wasm into `/out` mid-build — is
  [`planted-artifact.spec.ts`](../../../services/builder/test/planted-artifact.spec.ts). It is an AR1
  question, not an extraction one.
- **T6's isolated-stage egress guard** is
  [`isolated-stage-egress.spec.ts`](../../../services/builder/test/isolated-stage-egress.spec.ts), and
  it deliberately does **not** appear in `services/builder/test/differential/expected-failures.json`:
  that harness asserts its entries actually fail, so a passing case filed there turns the suite red.
