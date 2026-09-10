import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRustToolchainFile,
  detectSourceCargoSourceOverride,
  extractBuildPackage,
  parseBuildArtifactReports,
  replayableBuildOptions,
  removeRecordedMetaBldopts,
  resolveReportedArtifact,
  selectArtifactFromOutput,
  withDefaultBuildEnv,
  writeVendorCargoConfig,
} from "../src/modules/builder/run-cli.js";
import { escapeShellWord, splitShellWords, unescapeShellWord } from "@scvs/core";

/**
 * Reproducibility guards for the mode="build" rebuild path (the container-orchestration equivalent of `stellar
 * contract build` without `--verifiable`).
 */

describe("replayableBuildOptions", () => {
  it("replays --meta so the rebuilt contractmetav0 matches the original build", () => {
    // SEP-58 `bldopt` records the original build's user metadata; dropping it would leave the rebuilt Wasm
    // missing those entries and guarantee a mismatch.
    const spaced = replayableBuildOptions(["--meta", "author=alice"]);
    expect(spaced.forwarded).toEqual(["--meta", "author=alice"]);
    expect(spaced.unparsable).toEqual([]);

    // PR 2585's own recorded spelling is the inline form.
    const inline = replayableBuildOptions(["--meta=home_domain=example.com"]);
    expect(inline.forwarded).toEqual(["--meta=home_domain=example.com"]);
    expect(inline.unparsable).toEqual([]);
  });

  it("replays multiple --meta entries and preserves recorded order", () => {
    const { forwarded } = replayableBuildOptions(["--meta", "a=1", "--meta=b=2", "--meta", "c=3"]);
    expect(forwarded).toEqual(["--meta", "a=1", "--meta=b=2", "--meta", "c=3"]);
  });

  it("forwards recorded build options by default instead of allowlisting", () => {
    const { forwarded, unparsable } = replayableBuildOptions([
      "--optimize",
      "--all-features",
      "--no-default-features",
      "--features",
      "a,b",
      "--profile",
      "release-fast",
      "--some-future-flag=1",
    ]);
    expect(forwarded).toEqual([
      "--optimize",
      "--all-features",
      "--no-default-features",
      "--features",
      "a,b",
      "--profile",
      "release-fast",
      "--some-future-flag=1",
    ]);
    expect(unparsable).toEqual([]);
  });

  it("does not replay options the rebuild command re-issues itself", () => {
    // --manifest-path/--package are appended explicitly by the rebuild; --env is
    // applied as a docker `-e` flag. Replaying them here would duplicate or contradict them.
    const { forwarded, reissued, unparsable } = replayableBuildOptions([
      "--locked",
      "--offline",
      "--manifest-path",
      "sub/Cargo.toml",
      "--package=my-contract",
      "-p",
      "other",
      "--env",
      "A=1",
      "--env=B=2",
    ]);
    expect(forwarded).toEqual(["--locked", "--offline"]);
    expect(reissued).toEqual([
      "--manifest-path",
      "sub/Cargo.toml",
      "--package=my-contract",
      "-p",
      "other",
      "--env",
      "A=1",
      "--env=B=2",
    ]);
    expect(unparsable).toEqual([]);
  });

  it("reports an entry whose shell encoding cannot be parsed", () => {
    const parsed = replayableBuildOptions(["--meta=ok=true", "'unterminated"]);
    expect(parsed.forwarded).toEqual(["--meta=ok=true"]);
    expect(parsed.unparsable).toEqual([{ entry: "'unterminated", reason: "unterminated_quote" }]);
  });

  it("handles an empty bldopt", () => {
    expect(replayableBuildOptions([])).toEqual({ forwarded: [], reissued: [], unparsable: [] });
  });
});

describe("metadata replay bldopt filtering", () => {
  it("removes recorded --meta entries from forwarded build options once deployed metadata is replayed", () => {
    expect(
      removeRecordedMetaBldopts([
        "--locked",
        "--meta",
        "author=alice",
        "--optimize",
        "--meta=home_domain=example.com",
        "--features",
        "testutils",
      ]),
    ).toEqual(["--locked", "--optimize", "--features", "testutils"]);
  });

  it("removes a dangling --meta token rather than forwarding an invalid metadata flag", () => {
    expect(removeRecordedMetaBldopts(["--locked", "--meta"])).toEqual(["--locked"]);
  });
});

describe("extractBuildPackage", () => {
  it.each([
    [["--package", "contract-a"], "contract-a"],
    [["-p", "contract-a"], "contract-a"],
    [["--package=contract-a"], "contract-a"],
    [["-p=contract-a"], "contract-a"],
    [["--manifest-path=contracts/Cargo.toml"], undefined],
  ])("extracts the package from %p", (bldopt, expected) => {
    expect(extractBuildPackage(bldopt)).toBe(expected);
  });

  it("honours shell-escaped package names in recorded entries", () => {
    expect(extractBuildPackage(["--package='contract a'"])).toBe("contract a");
  });
});

describe("shell word parsing", () => {
  it("round-trips the reference-style env encoding as one word", () => {
    expect(unescapeShellWord("--env=B='this is very nice'")).toEqual({
      ok: true,
      word: "--env=B=this is very nice",
    });
    expect(unescapeShellWord("'it'\\''s nice'")).toEqual({ ok: true, word: "it's nice" });
    expect(unescapeShellWord("a\\ b")).toEqual({ ok: true, word: "a b" });
  });

  it("keeps double-quoted dollar values literal when the reference records them", () => {
    expect(unescapeShellWord('"$x"')).toEqual({ ok: true, word: "$x" });
  });

  it("rejects unterminated quotes and multiple words", () => {
    expect(unescapeShellWord("'unterminated")).toMatchObject({ ok: false, reason: "unterminated_quote" });
    expect(unescapeShellWord("one two")).toMatchObject({ ok: false, reason: "multiple_words" });
  });

  it("escapes words so the parser reads back the same value", () => {
    for (const word of ["plain", "a b", "it's nice", "$x", "semi;colon"]) {
      const escaped = escapeShellWord(word);
      expect(splitShellWords(escaped)).toEqual({ ok: true, words: [word] });
    }
  });
});

describe("withDefaultBuildEnv", () => {
  it("pins RUSTUP_TOOLCHAIN to the toolchain probed from the build image", () => {
    // Without this a rust-toolchain.toml in the submitted source makes rustup switch toolchains, so the image
    // digest no longer determines the compiler.
    const env = withDefaultBuildEnv([], { rustupToolchain: "1.85.0-x86_64-unknown-linux-gnu" });
    expect(env).toContain("RUSTUP_TOOLCHAIN=1.85.0-x86_64-unknown-linux-gnu");
  });

  it("omits RUSTUP_TOOLCHAIN when the probe found nothing", () => {
    const env = withDefaultBuildEnv([], { cargoHome: "/out/cargo-home" });
    expect(env.some((entry) => entry.startsWith("RUSTUP_TOOLCHAIN="))).toBe(false);
  });

  it("lets the original build's own recorded RUSTUP_TOOLCHAIN win", () => {
    // Replaying the original build faithfully takes precedence over our default.
    const env = withDefaultBuildEnv(["RUSTUP_TOOLCHAIN=1.81.0"], { rustupToolchain: "1.85.0" });
    expect(env.filter((entry) => entry.startsWith("RUSTUP_TOOLCHAIN="))).toEqual([
      "RUSTUP_TOOLCHAIN=1.81.0",
    ]);
  });

  it("still applies the pre-existing cargo defaults", () => {
    const env = withDefaultBuildEnv([], {
      cargoHome: "/out/cargo-home",
      cargoNetOffline: true,
      rustupToolchain: "1.85.0",
    });
    expect(env).toEqual(
      expect.arrayContaining([
        "CARGO_TARGET_DIR=/out/target",
        "TMPDIR=/out/tmp",
        "CARGO_HOME=/out/cargo-home",
        "CARGO_NET_OFFLINE=true",
        "RUSTUP_TOOLCHAIN=1.85.0",
      ]),
    );
  });
});

describe("writeVendorCargoConfig", () => {
  it("writes the vendor redirect to CARGO_HOME, never into the source tree", async () => {
    // Writing into the source would mutate the bytes source_sha256 describes and clobber any .cargo/config.toml
    // the project ships (e.g. [build] rustflags, which changes codegen).
    const root = await mkdtemp(join(tmpdir(), "scvs-cargo-cfg-"));
    const cargoHome = join(root, "cargo-home");

    const containerPath = await writeVendorCargoConfig(cargoHome, "/vendor");

    expect(containerPath).toBe("/out/cargo-home/config.toml");
    const written = await readFile(join(cargoHome, "config.toml"), "utf8");
    expect(written).toContain("[source.crates-io]");
    expect(written).toContain('replace-with = "vendored-sources"');
    expect(written).toContain('directory = "/vendor"');
    expect(written).toContain("offline = true");
  });

  it("preserves a project's own .cargo/config.toml untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-cargo-keep-"));
    const sourceRoot = join(root, "source");
    await mkdir(join(sourceRoot, ".cargo"), { recursive: true });
    const projectConfig = '[build]\nrustflags = ["-C", "target-feature=+bulk-memory"]\n';
    await writeFile(join(sourceRoot, ".cargo", "config.toml"), projectConfig);

    await writeVendorCargoConfig(join(root, "cargo-home"), "/vendor");

    // rustflags survive: they affect codegen, so losing them changes the Wasm bytes.
    await expect(readFile(join(sourceRoot, ".cargo", "config.toml"), "utf8")).resolves.toBe(
      projectConfig,
    );
  });
});

describe("detectSourceCargoSourceOverride", () => {
  it("returns undefined when the project ships no cargo config", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-no-cfg-"));
    await expect(detectSourceCargoSourceOverride(sourceRoot)).resolves.toBeUndefined();
  });

  it("ignores a project cargo config that does not override sources", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-build-cfg-"));
    await mkdir(join(sourceRoot, ".cargo"), { recursive: true });
    await writeFile(
      join(sourceRoot, ".cargo", "config.toml"),
      '[build]\nrustflags = ["-C", "opt-level=z"]\n',
    );
    await expect(detectSourceCargoSourceOverride(sourceRoot)).resolves.toBeUndefined();
  });

  it("detects a [source.*] block that would defeat the vendor redirect", async () => {
    // Project-level config outranks CARGO_HOME, so vendoring would not apply and the build would fail obscurely
    // under --network none.
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-src-cfg-"));
    await mkdir(join(sourceRoot, ".cargo"), { recursive: true });
    await writeFile(
      join(sourceRoot, ".cargo", "config.toml"),
      '[source.crates-io]\nreplace-with = "mirror"\n',
    );
    await expect(detectSourceCargoSourceOverride(sourceRoot)).resolves.toBe(
      join(".cargo", "config.toml"),
    );
  });

  it("detects the dotted-key spelling and the legacy .cargo/config filename", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-src-cfg-legacy-"));
    await mkdir(join(sourceRoot, ".cargo"), { recursive: true });
    await writeFile(
      join(sourceRoot, ".cargo", "config"),
      'source.crates-io.replace-with = "mirror"\n',
    );
    await expect(detectSourceCargoSourceOverride(sourceRoot)).resolves.toBe(
      join(".cargo", "config"),
    );
  });
});

describe("detectRustToolchainFile", () => {
  it("returns undefined when the source pins no toolchain", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-no-tc-"));
    await expect(detectRustToolchainFile(sourceRoot)).resolves.toBeUndefined();
  });

  it("detects rust-toolchain.toml", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-tc-toml-"));
    await writeFile(join(sourceRoot, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.81.0"\n');
    await expect(detectRustToolchainFile(sourceRoot)).resolves.toBe("rust-toolchain.toml");
  });

  it("detects the legacy bare rust-toolchain file", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-tc-bare-"));
    await writeFile(join(sourceRoot, "rust-toolchain"), "1.81.0\n");
    await expect(detectRustToolchainFile(sourceRoot)).resolves.toBe("rust-toolchain");
  });

  it("does not mistake a directory for a toolchain file", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-tc-dir-"));
    await mkdir(join(sourceRoot, "rust-toolchain"));
    await expect(detectRustToolchainFile(sourceRoot)).resolves.toBeUndefined();
  });
});

describe("parseBuildArtifactReports", () => {
  it("parses the released CLI format (path and size on one line)", () => {
    const output = [
      "ℹ️ Build Summary:",
      "Wasm File: /out/my_contract.wasm (1234 bytes)",
      "Wasm Hash: " + "a".repeat(64),
      "Exported Functions: 3 found",
    ].join("\n");
    expect(parseBuildArtifactReports(output)).toEqual([
      { containerPath: "/out/my_contract.wasm", sha256: "a".repeat(64) },
    ]);
  });

  it("parses the PR 2585/2586 format (separate Wasm Size line)", () => {
    const output = [
      "Build Summary:",
      "Wasm File: /out/my_contract.wasm",
      "Wasm Hash: " + "b".repeat(64),
      "Wasm Size: 1234 bytes",
    ].join("\n");
    expect(parseBuildArtifactReports(output)).toEqual([
      { containerPath: "/out/my_contract.wasm", sha256: "b".repeat(64) },
    ]);
  });

  it("keeps the optimized-size annotation out of the path", () => {
    const output = "Wasm File: /out/c.wasm (900 bytes optimized (original size was 1800 bytes))";
    expect(parseBuildArtifactReports(output)[0].containerPath).toBe("/out/c.wasm");
  });

  it("parses one report per contract in a multi-package build", () => {
    const output = [
      "Wasm File: /out/first.wasm (1 bytes)",
      "Wasm Hash: " + "1".repeat(64),
      "Wasm File: /out/second.wasm (2 bytes)",
      "Wasm Hash: " + "2".repeat(64),
    ].join("\n");
    expect(parseBuildArtifactReports(output)).toEqual([
      { containerPath: "/out/first.wasm", sha256: "1".repeat(64) },
      { containerPath: "/out/second.wasm", sha256: "2".repeat(64) },
    ]);
  });

  it("ignores the prefixed forms a build script can reach", () => {
    // `build.rs` output does not reach this buffer at all — cargo captures it — and a `cargo:warning=`
    // directive arrives prefixed `warning: <pkg>@<ver>: `, which the anchored match rejects.
    const output = [
      "   Compiling my_contract v0.1.0",
      "warning: wrote /artifact/planted.wasm",
      "warning: my_contract@0.1.0: Wasm File: /artifact/planted.wasm",
      "Finished `release` profile",
    ].join("\n");
    expect(parseBuildArtifactReports(output)).toEqual([]);
  });

  it("★ parses an unprefixed line a proc macro printed, because that is what the compile can emit", () => {
    // Measured against the pinned CLI: a proc macro's `println!`/`eprintln!` reaches cargo's streams
    // verbatim at column 0, and the tool forwards them. The parse cannot tell this from the tool's own
    // summary — which is why identity comes from the output mount and this line is only ever confirmation.
    const output = [
      "   Compiling my_contract v0.1.0",
      "Wasm File: /artifact/planted.wasm",
      "Wasm Hash: " + "e".repeat(64),
      "ℹ️  Build Summary:",
      "    Wasm File: /artifact/my_contract.wasm (1234 bytes)",
      "    Wasm Hash: " + "a".repeat(64),
    ].join("\n");
    expect(parseBuildArtifactReports(output)).toEqual([
      { containerPath: "/artifact/planted.wasm", sha256: "e".repeat(64) },
      { containerPath: "/artifact/my_contract.wasm", sha256: "a".repeat(64) },
    ]);
  });
});

describe("selectArtifactFromOutput", () => {
  const dir = "/tmp/scvs-artifact-test";
  const candidate = `${dir}/my_contract.wasm`;

  it("fails when the tool reported nothing — never falls back to a scan", () => {
    const result = selectArtifactFromOutput({ candidates: [candidate], reports: [], artifactDir: dir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("artifact_report_missing");
  });

  it("takes the sole artifact the tool reported", () => {
    const result = selectArtifactFromOutput({
      candidates: [candidate],
      reports: [{ containerPath: "/artifact/my_contract.wasm" }],
      artifactDir: dir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hostPath).toBe(candidate);
  });

  it("refuses when the build wrote more than one Wasm, whatever was reported", () => {
    const result = selectArtifactFromOutput({
      candidates: [candidate, `${dir}/other.wasm`],
      reports: [{ containerPath: "/artifact/my_contract.wasm" }],
      artifactDir: dir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("artifact_report_ambiguous");
  });

  it("refuses when no report names the artifact that exists", () => {
    const result = selectArtifactFromOutput({
      candidates: [candidate],
      reports: [{ containerPath: "/artifact/something_else.wasm" }],
      artifactDir: dir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("artifact_report_disagrees_with_output");
  });

  it("does not need a package name to be safe — the mount decides, not the argv", () => {
    // `BuildRecipe.package` is optional, so the old disambiguation was unavailable for many jobs.
    const result = selectArtifactFromOutput({
      candidates: [candidate],
      reports: [
        { containerPath: "/artifact/planted.wasm", sha256: "e".repeat(64) },
        { containerPath: "/artifact/my_contract.wasm", sha256: "a".repeat(64) },
      ],
      artifactDir: dir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sha256).toBe("a".repeat(64));
  });
});
