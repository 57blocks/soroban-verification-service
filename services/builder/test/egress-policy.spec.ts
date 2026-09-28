import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCargoPrefetchUrls,
  evaluatePrefetchEgressPolicy,
  evaluatePrefetchUrl,
  evaluateVendoredEgressPolicy,
  stripTomlComments,
} from "../src/modules/builder/egress-policy.js";

const ALLOWED = ["crates.io", "github.com", "githubusercontent.com"];

async function sourceTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scvs-egress-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

describe("collectCargoPrefetchUrls — only what cargo dereferences", () => {
  it("ignores the documentation link that failed a real job", async () => {
    const root = await sourceTree({
      "Cargo.toml": [
        "[package]",
        'name = "soroban-logging-contract"',
        'version = "0.0.0"',
        "# https://developers.stellar.org/docs/build/smart-contracts/example-contracts/logging#setup",
        'documentation = "https://developers.stellar.org/docs/build/smart-contracts/example-contracts/logging"',
        'homepage = "https://stellar.org"',
        'repository = "https://gitea.example.invalid/x/y"',
        "",
        "[dependencies]",
        'soroban-sdk = "22.0.0"',
      ].join("\n"),
    });

    await expect(collectCargoPrefetchUrls(root)).resolves.toEqual([]);
    await expect(evaluatePrefetchEgressPolicy(root, { prefetchAllowedHosts: ALLOWED })).resolves.toEqual({
      ok: true,
      allowed_hosts: ALLOWED,
    });
  });

  it("still collects the git, registry, index and source keys", async () => {
    const root = await sourceTree({
      "Cargo.toml": '[dependencies]\nfoo = { git = "https://github.com/a/b", branch = "main" }\n',
      "Cargo.lock": '[[package]]\nname = "foo"\nsource = "git+https://github.com/a/b?rev=deadbeef"\n',
      ".cargo/config.toml": [
        "[source.mirror]",
        'registry = "sparse+https://index.crates.io/"',
        "[registries.other]",
        'index = "https://gitlab.com/x/index"',
      ].join("\n"),
    });

    await expect(collectCargoPrefetchUrls(root)).resolves.toEqual(
      expect.arrayContaining([
        "https://github.com/a/b",
        "git+https://github.com/a/b?rev=deadbeef",
        "sparse+https://index.crates.io/",
        "https://gitlab.com/x/index",
      ]),
    );
  });

  it("still skips a `vendor/` directory in the submitter's own source tree", async () => {
    const root = await sourceTree({
      "Cargo.toml": '[dependencies]\nfoo = "1.0"\n',
      "vendor/stale-crate/Cargo.toml": 'git = "https://evil.example.invalid/a/b"\n',
    });
    await expect(collectCargoPrefetchUrls(root)).resolves.toEqual([]);
  });

  it("does not read a dependency out of a commented-out line", async () => {
    const root = await sourceTree({
      "Cargo.toml": '[dependencies]\n# foo = { git = "https://evil.example.invalid/a/b" }\n',
    });
    await expect(collectCargoPrefetchUrls(root)).resolves.toEqual([]);
  });

  it("keeps a `#` that is inside a quoted value", () => {
    expect(stripTomlComments('git = "https://github.com/a/b#frag" # trailing')).toBe(
      'git = "https://github.com/a/b#frag" ',
    );
  });
});

describe("evaluatePrefetchUrl — cargo's `<kind>+<url>` source forms", () => {
  it.each([
    ["git+https://github.com/a/b?rev=1", "github.com"],
    ["registry+https://github.com/rust-lang/crates.io-index", "github.com"],
    ["sparse+https://index.crates.io/", "index.crates.io"],
    ["https://static.crates.io/api/v1/crates/x/download", "static.crates.io"],
  ])("accepts %s on an allowed host", (url) => {
    expect(evaluatePrefetchUrl(url, ALLOWED)).toEqual({ ok: true });
  });

  it("rejects a git+ source whose host is not allowed, on the host and not the scheme", () => {
    expect(evaluatePrefetchUrl("git+https://git.sr.ht/~u/r", ALLOWED)).toEqual({
      ok: false,
      reason: "Dependency prefetch host is not in the allowlist: git.sr.ht",
    });
  });

  it("still refuses a disallowed scheme and a private host", () => {
    expect(evaluatePrefetchUrl("ftp://crates.io/x", ALLOWED)).toEqual({
      ok: false,
      reason: "Dependency prefetch URL uses a disallowed scheme: ftp:",
    });
    expect(evaluatePrefetchUrl("https://169.254.169.254/latest/meta-data", ALLOWED)).toEqual({
      ok: false,
      reason: "Dependency prefetch URL targets a private, local, or metadata host: 169.254.169.254",
    });
  });
});

describe("evaluateVendoredEgressPolicy — a transitive dependency's own source", () => {
  it("catches a disallowed host that only appears in a vendored crate's own Cargo.toml", async () => {
    const vendorDir = await sourceTree({
      "evil-helper-0.1.0/Cargo.toml": [
        "[package]",
        'name = "evil-helper"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'payload = { git = "https://attacker.example/payload-repo" }',
      ].join("\n"),
      "evil-helper-0.1.0/.cargo-checksum.json": '{"files":{},"package":"deadbeef"}',
    });

    await expect(evaluateVendoredEgressPolicy(vendorDir, ALLOWED)).resolves.toEqual({
      ok: false,
      allowed_hosts: ALLOWED,
      blocked_url: "https://attacker.example/payload-repo",
      detail: "Dependency prefetch host is not in the allowlist: attacker.example",
    });
  });

  it("passes a vendor tree where every transitive source is allowed", async () => {
    const vendorDir = await sourceTree({
      "soroban-sdk-22.0.0/Cargo.toml": [
        "[package]",
        'name = "soroban-sdk"',
        'version = "22.0.0"',
        "",
        "[dependencies]",
        'soroban-env-common = { git = "https://github.com/stellar/rs-soroban-env" }',
      ].join("\n"),
    });

    await expect(evaluateVendoredEgressPolicy(vendorDir, ALLOWED)).resolves.toEqual({
      ok: true,
      allowed_hosts: ALLOWED,
    });
  });

  it("catches a disallowed host nested under a vendored crate's own `vendor/` directory", async () => {
    const vendorDir = await sourceTree({
      "evil-sys-0.1.0/vendor/inner-dep/Cargo.toml": [
        "[package]",
        'name = "inner-dep"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'payload = { git = "https://attacker.example/payload-repo" }',
      ].join("\n"),
    });

    await expect(evaluateVendoredEgressPolicy(vendorDir, ALLOWED)).resolves.toEqual({
      ok: false,
      allowed_hosts: ALLOWED,
      blocked_url: "https://attacker.example/payload-repo",
      detail: "Dependency prefetch host is not in the allowlist: attacker.example",
    });
  });
});
