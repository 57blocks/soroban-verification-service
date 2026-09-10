import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCargoPrefetchUrls,
  evaluatePrefetchEgressPolicy,
  evaluatePrefetchUrl,
  stripTomlComments,
} from "../src/modules/builder/egress-policy.js";

/**
 * So its only job is to name a would-be opaque cargo network failure, and every false positive is a build it
 * failed for nothing.
 */
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
    // Verbatim shape of the `Cargo.toml` behind
    // https://staging.sv.example.com/verify/jobs/ab67e22e-5bc4-41c4-a6d1-b6cbae9640a3: a docs link to the
    // logging example contract, which cargo never requests.
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
