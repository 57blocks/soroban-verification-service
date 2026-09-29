import { RegistryStatusObject, SEP58_BLDOPT_ENTRY, parseDto } from "@scvs/core";
import { validateSubmittedManifest } from "../src/modules/preflight/manifest.js";
import type { VerificationTarget } from "@scvs/core";

const TARGET: VerificationTarget = {
  network: "testnet",
  wasm_hash: "8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c",
};

const SOURCE_SHA256 = "a".repeat(64);

const submit = (bldopt: unknown) =>
  validateSubmittedManifest(
    {
      schema: "stellar-submitted-source-verification-manifest-v1",
      source_sha256: SOURCE_SHA256,
      source_uri: "https://example.test/source.tar.gz",
      ...(bldopt === undefined ? {} : { bldopt }),
    },
    TARGET,
  );

const rejectionFor = (bldopt: unknown): string => {
  const result = submit(bldopt);
  if (result.ok) throw new Error(`expected ${JSON.stringify(bldopt)} to be rejected`);
  expect(result.error).toBe("invalid_manifest");
  return result.detail;
};

describe("SO5 at submit — a flag and its value are one entry", () => {
  it("refuses the incident's own input and names the entry to write instead", () => {
    const detail = rejectionFor(["--package", "reflector-pulse-contract"]);
    expect(detail).toContain('"reflector-pulse-contract"');
    expect(detail).toContain('"--package=reflector-pulse-contract"');
  });

  it("refuses a short flag, which SO5 cannot represent at all", () => {
    for (const bldopt of [["-p", "my-contract"], ["-p=my-contract"]]) {
      expect(rejectionFor(bldopt)).toContain("--package=my-contract");
    }
  });

  it("refuses a bare word without inventing a suggestion for it", () => {
    const detail = rejectionFor(["reflector-pulse-contract"]);
    expect(detail).toContain("not a complete flag");
    expect(detail).not.toContain("=reflector-pulse-contract");
  });

  it("reports the first offending entry, not the last", () => {
    expect(rejectionFor(["--locked", "--features", "a", "--package", "b"])).toContain('"a"');
  });
});

describe("SO5 at submit — what must keep working", () => {
  it("accepts every bldopt shape the repository's own fixtures use", () => {
    for (const bldopt of [
      ["--locked", "--package=verified-demo", "--optimize"],
      ["--manifest-path=contracts/hello/Cargo.toml", "--package=hello-contract"],
      ["--meta=source_repo='github:stellar/example'"],
      ["--features=a,b"],
      ["--package=reflector-pulse-contract"],
    ]) {
      const result = submit(bldopt);
      if (!result.ok) throw new Error(`${JSON.stringify(bldopt)} was refused: ${result.detail}`);
      expect(result.manifest.bldopt).toEqual(bldopt);
    }
  });

  it("leaves absent and empty bldopt alone", () => {
    expect(submit(undefined).ok).toBe(true);
    expect(submit([]).ok).toBe(true);
  });

  it("still refuses a non-array before looking at entry shape", () => {
    expect(rejectionFor("--package=x")).toContain("must be an array of strings");
  });
});

describe("S12 at submit — an escaping manifest path is refused before a job exists", () => {
  it("refuses a manifest path that escapes the source tree", () => {
    const result = submit(["--manifest-path=../../outside/Cargo.toml"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("policy_rejected");
      expect(result.detail).toContain("outside the mounted source tree");
    }
  });

  it("refuses an absolute manifest path", () => {
    const result = submit(["--manifest-path=/etc/passwd"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("policy_rejected");
  });

  it("refuses an escape hidden behind quoting the shell-unescape strips", () => {
    const result = submit(["--manifest-path='../../etc/Cargo.toml'"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("policy_rejected");
  });

  it("accepts a manifest path whose internal `..` does not escape the tree", () => {
    const result = submit(["--manifest-path=contracts/../packages/x/Cargo.toml"]);
    expect(result.ok).toBe(true);
  });

  it("refuses the two-token form the same as the `=` form — SO5's shape check catches it first", () => {
    const result = submit(["--manifest-path", "../../outside/Cargo.toml"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_manifest");
  });

  it("leaves a trailing bare --manifest-path (no value) unvalidated rather than crashing", () => {
    const result = submit(["--manifest-path"]);
    expect(result.ok).toBe(true);
  });

  it("leaves a submission with no --manifest-path unaffected", () => {
    expect(submit(["--locked", "--package=hello-contract"]).ok).toBe(true);
  });
});

describe("the submit gate and the publish validator agree, by construction", () => {
  const statusObjectFor = (bldopt: string[]) =>
    parseDto(RegistryStatusObject, {
      schema: "stellar-verification-status",
      schema_version: "1.0",
      wasm_hash: TARGET.wasm_hash,
      updated_at: "2026-08-13T07:00:00.000Z",
      source_code_verifications: [
        {
          verifier: { name: "test", url: "https://verify.example.com" },
          status: "verified",
          recipe_source: "on_chain_metadata",
          image_trust_level: "official_trusted",
          bldopt,
          source_sha256: "0".repeat(64),
          processed_at: "2026-08-13T07:00:00.000Z",
        },
      ],
    });

  it("publishes everything submit accepts", () => {
    const accepted = ["--locked", "--package=hello-contract", "--meta=source_repo='github:a/b'"];
    expect(submit(accepted).ok).toBe(true);
    expect(statusObjectFor(accepted).source_code_verifications[0].bldopt).toEqual(accepted);
  });

  it("would have failed at publish on exactly what submit now refuses", () => {
    const refused = ["--package", "reflector-pulse-contract"];
    expect(submit(refused).ok).toBe(false);
    expect(() => statusObjectFor(refused)).toThrow();
  });

  it("is the same regex on both sides", () => {
    expect(SEP58_BLDOPT_ENTRY.test("--package=x")).toBe(true);
    expect(SEP58_BLDOPT_ENTRY.test("x")).toBe(false);
  });
});
