import { createHash, randomBytes } from "node:crypto";
import { compareSourceAgainstChain } from "../src/modules/preflight/manifest.js";

const hash = () => createHash("sha256").update(randomBytes(64)).digest("hex");

describe("compareSourceAgainstChain", () => {
  it("refuses a submission whose archive hashes to something the chain does not record", () => {
    const chain = hash();
    const submitted = hash();

    const result = compareSourceAgainstChain(chain, submitted);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("source_archive_not_chain_recorded");
    expect(result.detail).toContain(chain);
    expect(result.detail).toContain(submitted);
  });

  it("admits a submission whose archive is the one the chain records", () => {
    const same = hash();
    expect(compareSourceAgainstChain(same, same)).toEqual({ ok: true });
  });

  it("treats hex case as insignificant", () => {
    const lower = hash();
    expect(compareSourceAgainstChain(lower.toUpperCase(), lower)).toEqual({ ok: true });
    expect(compareSourceAgainstChain(lower, lower.toUpperCase())).toEqual({ ok: true });
  });

  it("admits a contract that records no source_sha256 at all", () => {
    expect(compareSourceAgainstChain(undefined, hash())).toEqual({ ok: true });
  });

  it("admits the submission when the chain could not be read", () => {
    expect(compareSourceAgainstChain("", hash())).toEqual({ ok: true });
  });
});
