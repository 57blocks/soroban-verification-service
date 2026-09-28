import { describe, expect, test } from "vitest";
import { evidencePrefill } from "@/features/verification/utils/evidence-prefill.util";

describe("the evidence a verifier's answer prefills", () => {
  test("copies the four fields it recognises", () => {
    expect(
      evidencePrefill({
        source_sha256: "a".repeat(64),
        source_uri: "https://example.test/src.tar.gz",
        bldarg: "contract build",
        bldopt: "--package token",
      }),
    ).toEqual({
      source_sha256: "a".repeat(64),
      source_uri: "https://example.test/src.tar.gz",
      bldarg: "contract build",
      bldopt: "--package token",
    });
  });

  test("joins an argument list into the string the input holds", () => {
    expect(evidencePrefill({ bldopt: ["--package", "token", "--profile", "release"] })).toEqual({
      bldopt: "--package token --profile release",
    });
  });

  test("keeps only the strings of a mixed argument list", () => {
    expect(evidencePrefill({ bldarg: ["cargo", 7, null, "build"] })).toEqual({ bldarg: "cargo build" });
  });

  test("drops a value of the wrong type instead of coercing it", () => {
    expect(evidencePrefill({ source_sha256: 42, source_uri: { href: "x" }, bldarg: true })).toEqual({});
  });

  test("returns no key for a field the answer does not state", () => {
    const prefill = evidencePrefill({ source_uri: "https://example.test/src.tar.gz" });
    expect(Object.keys(prefill)).toEqual(["source_uri"]);
  });

  test("an absent answer prefills nothing", () => {
    expect(evidencePrefill(undefined)).toEqual({});
    expect(evidencePrefill({})).toEqual({});
  });

  test("ignores keys it does not own", () => {
    expect(evidencePrefill({ wasm_hash: "b".repeat(64), network: "testnet" })).toEqual({});
  });
});
