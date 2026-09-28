import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import configuration from "../src/config/configuration.js";
import { handoffPath, readHandoff } from "../src/modules/builder/handoff.js";
import { runCommand } from "@scvs/core/process";
import { MaterialiseService } from "../src/modules/materialise/materialise.service.js";
import { zipArchive } from "./malicious-corpus.js";

describe("MaterialiseService — the archive the verify path is handed", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  async function materialise(archivePath: string, sha256: string, expectedSourceSha256?: string) {
    const handoffRoot = await mkdtemp(join(tmpdir(), "scvs-mat-handoff-"));
    const artifactDir = await mkdtemp(join(tmpdir(), "scvs-mat-artifacts-"));
    const jobId = "11111111-2222-3333-4444-555555555555";
    process.env.SCVS_HANDOFF_ROOT = handoffRoot;
    process.env.SCVS_ARTIFACT_DIR = artifactDir;
    process.env.SCVS_JOB_PARAMS_JSON = JSON.stringify({
      job_id: jobId,
      mode: "verify",
      source_ref: {
        type: "source_uri",
        visibility: "public",
        source_uri: archivePath,
        source_sha256: sha256,
      },
      ...(expectedSourceSha256 ? { expected_source_sha256: expectedSourceSha256 } : {}),
    });

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] })],
      providers: [MaterialiseService],
    }).compile();

    expect(await moduleRef.get(MaterialiseService).run()).toBe(0);
    return readHandoff(handoffPath(handoffRoot, jobId));
  }

  it("hands the CLI the inner archive for a .tar.gz.zip, byte for byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-mat-nested-"));
    await mkdir(join(root, "pkg", "src"), { recursive: true });
    await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    await writeFile(join(root, "pkg", "src", "lib.rs"), "pub fn hello() {}\n");
    const innerPath = join(root, "counter.tar.gz");
    const tar = await runCommand(["tar", "-czf", innerPath, "-C", root, "pkg"], { mirrorOutput: false });
    expect(tar.exit_code).toBe(0);
    const innerBytes = await readFile(innerPath);

    const outerPath = join(root, "counter.tar.gz.zip");
    const outerBytes = zipArchive([{ name: "counter.tar.gz", body: innerBytes.toString("latin1") }]);
    await writeFile(outerPath, outerBytes);
    const outerSha = createHash("sha256").update(outerBytes).digest("hex");

    const handoff = await materialise(outerPath, outerSha);

    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;

    expect(handoff.source.canonical_path).toBeDefined();
    expect(await readFile(handoff.source.canonical_path!)).toEqual(innerBytes);

    expect(handoff.source.canonical_path!.endsWith(".tar.gz")).toBe(true);

    expect(handoff.source.source_sha256).toBe(outerSha);

    expect((await readdir(handoff.source.workspace_path)).sort()).toEqual(["Cargo.toml", "src"]);

    expect(handoff.source.canonicalisation).toEqual({
      depth: 1,
      outer_format: "zip",
      canonical_format: "gzip",
      canonical_sha256: createHash("sha256").update(innerBytes).digest("hex"),
      reconstruction: "no_oracle",
      uploaded: false,
    });

    const handoffEntries = await readdir(join(handoff.source.workspace_path, ".."));
    expect(handoffEntries.filter((entry) => entry.includes("-peel-"))).toEqual([]);
  });

  it("leaves an ordinary .tar.gz exactly as it was — depth 0 reports nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-mat-plain-"));
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    const archivePath = join(root, "counter.tar.gz");
    await runCommand(["tar", "-czf", archivePath, "-C", root, "pkg"], { mirrorOutput: false });
    const bytes = await readFile(archivePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const handoff = await materialise(archivePath, sha256);

    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.source.canonical_path).toBe(archivePath);
    expect(handoff.source.canonicalisation).toBeUndefined();
    expect(await readdir(handoff.source.workspace_path)).toEqual(["Cargo.toml"]);
  });

  it("★ refuses an archive the chain does not record, and does not rebuild one", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-mat-refuse-"));
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    const archivePath = join(root, "counter.tar.gz");
    await runCommand(["tar", "-czf", archivePath, "-C", root, "pkg"], { mirrorOutput: false });
    const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
    const chainSha256 = "3".repeat(64);

    const handoff = await materialise(archivePath, sha256, chainSha256);

    expect(handoff.ok).toBe(false);
    if (handoff.ok) throw new Error("unreachable");
    expect(handoff.reason).toBe("source_archive_not_chain_recorded");
    expect(handoff.status).toBe("source_hash_mismatch");
    expect(handoff.detail).toContain(chainSha256);
    expect(handoff.detail).toContain(sha256);
  });

  it("★ echoes the chain-recorded hash when the archive IS the one recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-mat-oracle-"));
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    const archivePath = join(root, "counter.tar.gz");
    await runCommand(["tar", "-czf", archivePath, "-C", root, "pkg"], { mirrorOutput: false });
    const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");

    // Lower-case: `expected_source_sha256` must match /^[0-9a-f]{64}$/, so an upper-case oracle never reaches the gate.
    const handoff = await materialise(archivePath, sha256, sha256);

    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.source.canonicalisation).toEqual(
      expect.objectContaining({
        expected_source_sha256: sha256,
        canonical_sha256: sha256,
        reconstruction: "not_attempted",
      }),
    );
  });

  it("carries no oracle onto the record when the contract records none", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-mat-no-oracle-"));
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    const archivePath = join(root, "counter.tar.gz");
    await runCommand(["tar", "-czf", archivePath, "-C", root, "pkg"], { mirrorOutput: false });
    const inner = await mkdtemp(join(tmpdir(), "scvs-mat-no-oracle-zip-"));
    const zipPath = join(inner, "counter.tar.gz.zip");
    await writeFile(zipPath, zipArchive([{ name: "counter.tar.gz", body: await readFile(archivePath) }]));
    const sha256 = createHash("sha256").update(await readFile(zipPath)).digest("hex");

    const handoff = await materialise(zipPath, sha256);

    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.source.canonicalisation?.reconstruction).toBe("no_oracle");
    expect(handoff.source.canonicalisation?.expected_source_sha256).toBeUndefined();
  });
});
