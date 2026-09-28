import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComponentError,
  assertToolchainProvidesTargets,
  fetchAndVerifyComponents,
} from "../src/modules/composer/components.js";
import type { CompositionTemplate } from "../src/modules/composer/template.js";

const RUSTUP_BYTES = Buffer.from("#!/bin/sh\n# pretend rustup-init\n");
const RUSTUP_SHA = createHash("sha256").update(RUSTUP_BYTES).digest("hex");
const CLI_BYTES = Buffer.from("pretend stellar-cli tar.gz payload");
const CLI_SHA = createHash("sha256").update(CLI_BYTES).digest("hex");

function template(overrides: Partial<CompositionTemplate> = {}): CompositionTemplate {
  return {
    templateVersion: "v1",
    platform: "linux/arm64",
    baseImage: { reference: "docker.io/library/debian", digest: "sha256:" + "a".repeat(64) },
    rustup: {
      version: "1.29.0",
      targetTriple: "aarch64-unknown-linux-gnu",
      installerSha256: RUSTUP_SHA,
    },
    rust: { profile: "minimal", targets: ["wasm32v1-none"] },
    stellarCli: { repository: "stellar/stellar-cli", assetTargetTriple: "aarch64-unknown-linux-gnu" },
    runtimeLibraries: [],
    ...overrides,
  };
}

const LIB_BYTES = Buffer.from("pretend libdbus-1-3 .deb payload");
const LIB_SHA = createHash("sha256").update(LIB_BYTES).digest("hex");
const LIB_URL = "https://snapshot.debian.org/archive/debian/20230924T084440Z/pool/main/d/dbus/libdbus-1-3.deb";

function libraryPin(overrides: Partial<{ name: string; version: string; url: string; sha256: string }> = {}) {
  return {
    name: "libdbus-1-3",
    version: "1.14.10-1~deb12u1",
    url: LIB_URL,
    sha256: LIB_SHA,
    ...overrides,
  };
}

type FakeOptions = {
  manifestStatus?: number;
  manifestBody?: string;
  releaseStatus?: number;
  assets?: Array<{ name: string; browser_download_url: string; digest: string | null }>;
  cliBytes?: Buffer;
  rustupBytes?: Buffer;
  libraryBytes?: Buffer;
  libraryStatus?: number;
};

const MANIFEST_WITH_TARGET = [
  "[pkg.rust-std.target.wasm32v1-none]",
  'available = true',
  'hash = "abc"',
  "",
  "[pkg.rust-std.target.some-other-target]",
  "available = false",
  "",
].join("\n");

const MANIFEST_WITHOUT_TARGET = [
  "[pkg.rust-std.target.wasm32v1-none]",
  "available = false",
  "",
  "[pkg.rust-std.target.x86_64-unknown-linux-gnu]",
  "available = true",
  "",
].join("\n");

function fakeFetch(options: FakeOptions = {}): typeof fetch {
  const assets = options.assets ?? [
    {
      name: "stellar-cli-25.1.0-aarch64-unknown-linux-gnu.tar.gz",
      browser_download_url: "https://objects.githubusercontent.com/stellar-cli.tar.gz",
      digest: `sha256:${CLI_SHA}`,
    },
  ];
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      const status = options.releaseStatus ?? 200;
      if (status !== 200) return new Response("", { status });
      return new Response(JSON.stringify({ assets }), { status: 200 });
    }
    if (url.includes("/dist/channel-rust-")) {
      const status = options.manifestStatus ?? 200;
      return new Response(options.manifestBody ?? MANIFEST_WITH_TARGET, { status });
    }
    if (url.includes("rustup-init")) {
      return new Response((options.rustupBytes ?? RUSTUP_BYTES) as unknown as BodyInit, { status: 200 });
    }
    if (url.startsWith("https://snapshot.debian.org/")) {
      const status = options.libraryStatus ?? 200;
      if (status !== 200) return new Response("", { status });
      return new Response((options.libraryBytes ?? LIB_BYTES) as unknown as BodyInit, { status: 200 });
    }
    return new Response((options.cliBytes ?? CLI_BYTES) as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
}

async function context(): Promise<string> {
  return mkdtemp(join(tmpdir(), "composer-test-"));
}

const CLI_REV = "a048a57ad0b9a09b4b0dee76c0dc2e4a0e4f4d3c";
const pair = { cliver: `25.1.0#${CLI_REV}`, rsver: "1.95.0" };

describe("assertToolchainProvidesTargets", () => {
  it("★ refuses a toolchain whose manifest marks the pinned target unavailable", async () => {
    await expect(
      assertToolchainProvidesTargets({
        pair: { cliver: `25.1.0#${CLI_REV}`, rsver: "1.81.0" },
        template: template(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ manifestBody: MANIFEST_WITHOUT_TARGET }),
      }),
    ).rejects.toMatchObject({
      reason: "toolchain_target_unavailable",
      context: { rsver: "1.81.0", missing_targets: ["wasm32v1-none"] },
    });
  });

  it("refuses when the manifest describes no such target at all", async () => {
    await expect(
      assertToolchainProvidesTargets({
        pair,
        template: template(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({
          manifestBody: "[pkg.rust-std.target.x86_64-unknown-linux-gnu]\navailable = true\n",
        }),
      }),
    ).rejects.toMatchObject({ reason: "toolchain_target_unavailable" });
  });

  it("lets a toolchain that ships the target through", async () => {
    await expect(
      assertToolchainProvidesTargets({
        pair,
        template: template(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch(),
      }),
    ).resolves.toBeUndefined();
  });

  it("★ does not refuse when the manifest is unreachable — that is not a verdict about the pair", async () => {
    await expect(
      assertToolchainProvidesTargets({
        pair,
        template: template(),
        timeoutMs: 5_000,
      fetchImpl: fakeFetch({ manifestStatus: 503, manifestBody: MANIFEST_WITHOUT_TARGET }),
      }),
    ).resolves.toBeUndefined();
  });

  it("★ does not refuse when the manifest has a shape this reader does not understand", async () => {
    await expect(
      assertToolchainProvidesTargets({
        pair,
        template: template(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ manifestBody: "{\"schema\": \"something entirely new\"}" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not probe for an undated nightly, which no manifest describes", async () => {
    const seen: string[] = [];
    const recording = ((async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("", { status: 500 });
    }) as unknown) as typeof fetch;

    await expect(
      assertToolchainProvidesTargets({
        pair: { cliver: `25.1.0#${CLI_REV}`, rsver: "1.95.0-nightly" },
        template: template(),
        timeoutMs: 5_000,
        fetchImpl: recording,
      }),
    ).resolves.toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it("★ refuses before a single component byte is fetched, which is the whole point", async () => {
    const seen: string[] = [];
    const recording = ((async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return fakeFetch({ manifestBody: MANIFEST_WITHOUT_TARGET })(input as RequestInfo, init);
    }) as unknown) as typeof fetch;

    await expect(
      fetchAndVerifyComponents({
        pair: { cliver: `25.1.0#${CLI_REV}`, rsver: "1.81.0" },
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: recording,
      }),
    ).rejects.toMatchObject({ reason: "toolchain_target_unavailable" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/dist/channel-rust-1.81.0.toml");
    expect(seen.some((url) => url.includes("rustup-init"))).toBe(false);
    expect(seen.some((url) => url.includes("api.github.com"))).toBe(false);
  });
});

describe("fetchAndVerifyComponents", () => {
  it("addresses the release by the version half of cliver, never the whole recorded string", async () => {
    const seen: string[] = [];
    const recording = ((async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return fakeFetch()(input as RequestInfo, init);
    }) as unknown) as typeof fetch;

    await fetchAndVerifyComponents({
      pair,
      template: template(),
      contextDir: await context(),
      timeoutMs: 5_000,
      fetchImpl: recording,
    });

    const releaseUrl = seen.find((u) => u.startsWith("https://api.github.com/"));
    expect(releaseUrl).toBe("https://api.github.com/repos/stellar/stellar-cli/releases/tags/v25.1.0");
    expect(releaseUrl).not.toContain(CLI_REV);
    expect(releaseUrl).not.toContain("#");
  });

  it("does not treat the `#` in a recorded cliver as making it unaddressable", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch(),
      }),
    ).resolves.toBeDefined();
  });

  it("writes both verified components and records all three in the recipe", async () => {
    const contextDir = await context();
    const result = await fetchAndVerifyComponents({
      pair,
      template: template(),
      contextDir,
      timeoutMs: 5_000,
      fetchImpl: fakeFetch(),
    });

    expect(result.components.map((c) => c.kind).sort()).toEqual([
      "base_image",
      "rust_toolchain",
      "stellar_cli",
    ]);
    for (const component of result.components) {
      expect(component.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(await readFile(join(contextDir, "rustup-init"))).toEqual(RUSTUP_BYTES);
    expect(await readFile(join(contextDir, "stellar-cli-archive"))).toEqual(CLI_BYTES);
  });

  it("records the rustup INSTALLER as the rust_toolchain component, not a compiler checksum", async () => {
    const result = await fetchAndVerifyComponents({
      pair,
      template: template(),
      contextDir: await context(),
      timeoutMs: 5_000,
      fetchImpl: fakeFetch(),
    });
    const toolchain = result.components.find((c) => c.kind === "rust_toolchain")!;
    expect(toolchain.source).toBe(
      "https://static.rust-lang.org/rustup/archive/1.29.0/aarch64-unknown-linux-gnu/rustup-init",
    );
    expect(toolchain.sha256).toBe(`sha256:${RUSTUP_SHA}`);
  });

  it("refuses a rustup installer whose bytes do not match the template's pin", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ rustupBytes: Buffer.from("tampered") }),
      }),
    ).rejects.toMatchObject({ reason: "component_checksum_mismatch" });
  });

  it("refuses a CLI asset whose bytes do not match the digest the release API published", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ cliBytes: Buffer.from("tampered") }),
      }),
    ).rejects.toMatchObject({ reason: "component_checksum_mismatch" });
  });

  it("classifies a missing release tag as unreleased_cli, distinct from unreachable", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ releaseStatus: 404 }),
      }),
    ).rejects.toMatchObject({ reason: "unreleased_cli" });

    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ releaseStatus: 503 }),
      }),
    ).rejects.toMatchObject({ reason: "component_unreachable" });
  });

  it("refuses an asset carrying no published digest rather than composing unverified bytes", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({
          assets: [
            {
              name: "stellar-cli-25.1.0-aarch64-unknown-linux-gnu.tar.gz",
              browser_download_url: "https://objects.githubusercontent.com/x.tar.gz",
              digest: null,
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ reason: "asset_digest_unavailable" });
  });

  it("refuses to guess when a release publishes two matching assets", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({
          assets: [
            {
              name: "stellar-cli-25.1.0-aarch64-unknown-linux-gnu.tar.gz",
              browser_download_url: "https://example.com/a.tar.gz",
              digest: `sha256:${CLI_SHA}`,
            },
            {
              name: "stellar-cli-25.1.0-aarch64-unknown-linux-gnu-musl.tar.gz",
              browser_download_url: "https://example.com/b.tar.gz",
              digest: `sha256:${CLI_SHA}`,
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ reason: "ambiguous_release_asset" });
  });

  it("rejects a cliver that is not usable as a release tag before putting it in a URL", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair: { cliver: "../../etc/passwd", rsver: "1.95.0" },
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch(),
      }),
    ).rejects.toMatchObject({ reason: "unaddressable_cliver" });
  });

  it("writes each pinned runtime library into the context and records it in the recipe", async () => {
    const contextDir = await context();
    const result = await fetchAndVerifyComponents({
      pair,
      template: template({ runtimeLibraries: [libraryPin()] }),
      contextDir,
      timeoutMs: 5_000,
      fetchImpl: fakeFetch(),
    });

    expect(await readFile(join(contextDir, "libdbus-1-3.deb"))).toEqual(LIB_BYTES);
    const library = result.components.find((c) => c.kind === "runtime_library")!;
    expect(library.source).toBe(LIB_URL);
    expect(library.sha256).toBe(`sha256:${LIB_SHA}`);
    expect(result.components.map((c) => c.kind).sort()).toEqual([
      "base_image",
      "runtime_library",
      "rust_toolchain",
      "stellar_cli",
    ]);
  });

  it("refuses a runtime library whose bytes do not match the template's pin", async () => {
    const contextDir = await context();
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template({ runtimeLibraries: [libraryPin()] }),
        contextDir,
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ libraryBytes: Buffer.from("tampered") }),
      }),
    ).rejects.toMatchObject({ reason: "component_checksum_mismatch" });

    await expect(readFile(join(contextDir, "libdbus-1-3.deb"))).rejects.toThrow();
  });

  it("classifies an unreachable runtime library as retryable, not as a permanent pair property", async () => {
    await expect(
      fetchAndVerifyComponents({
        pair,
        template: template({ runtimeLibraries: [libraryPin()] }),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ libraryStatus: 404 }),
      }),
    ).rejects.toMatchObject({ reason: "component_unreachable" });
  });

  it("records nothing extra when a template pins no runtime library", async () => {
    const result = await fetchAndVerifyComponents({
      pair,
      template: template(),
      contextDir: await context(),
      timeoutMs: 5_000,
      fetchImpl: fakeFetch(),
    });
    expect(result.components.some((c) => c.kind === "runtime_library")).toBe(false);
  });

  it("exposes ComponentError's reason and context for the receipt to carry", async () => {
    let error: ComponentError | undefined;
    try {
      await fetchAndVerifyComponents({
        pair,
        template: template(),
        contextDir: await context(),
        timeoutMs: 5_000,
        fetchImpl: fakeFetch({ rustupBytes: Buffer.from("tampered") }),
      });
    } catch (thrown) {
      error = thrown as ComponentError;
    }

    expect(error).toBeInstanceOf(ComponentError);
    if (!error) throw new Error("expected a ComponentError");
    expect(error.context).toMatchObject({ component: "rustup_installer" });
    expect(error.context.expected_sha256).toBe(RUSTUP_SHA);
  });
});
