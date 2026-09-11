import { createHash, randomBytes } from "node:crypto";
import { compareSourceAgainstChain } from "../src/modules/preflight/manifest.js";

/**
 * The whole truth table lives here because the comparison is pure, so every branch is reachable without a
 * network, a CLI, or a fixture contract.
 */
const hash = () => createHash("sha256").update(randomBytes(64)).digest("hex");

describe("compareSourceAgainstChain", () => {
  it("refuses a submission whose archive hashes to something the chain does not record", () => {
    const chain = hash();
    const submitted = hash();

    const result = compareSourceAgainstChain(chain, submitted);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("source_archive_not_chain_recorded");
    // Both hashes must appear: the submitter cannot act on "they differ" alone, and the pair is what lets them
    // tell "I uploaded the wrong file" from "my tree is not the archived tree".
    expect(result.detail).toContain(chain);
    expect(result.detail).toContain(submitted);
  });

  it("admits a submission whose archive is the one the chain records", () => {
    const same = hash();
    expect(compareSourceAgainstChain(same, same)).toEqual({ ok: true });
  });

  it("treats hex case as insignificant", () => {
    // SEP-58 does not fix the case of these digests. Refusing over `A1` vs `a1` would report a mismatch that
    // does not exist.
    const lower = hash();
    expect(compareSourceAgainstChain(lower.toUpperCase(), lower)).toEqual({ ok: true });
    expect(compareSourceAgainstChain(lower, lower.toUpperCase())).toEqual({ ok: true });
  });

  it("admits a contract that records no source_sha256 at all", () => {
    // Every cli-legacy target, and any cli-58 one deployed without `--verifiable`.
    expect(compareSourceAgainstChain(undefined, hash())).toEqual({ ok: true });
  });

  it("admits the submission when the chain could not be read", () => {
    // The service collapses a failed or throwing lookup into `undefined`, and this is why: a gate that refused
    // on an unreadable chain would turn an RPC outage into a submission outage.
    expect(compareSourceAgainstChain("", hash())).toEqual({ ok: true });
  });
});
