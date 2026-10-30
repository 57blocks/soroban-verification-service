import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { runCommand } from "@scvs/core/process";
import configuration from "../src/config/configuration.js";
import { BuilderService } from "../src/modules/builder/builder.service.js";
import { HANDOFF_SCHEMA, handoffPath, readHandoff, writeHandoff } from "../src/modules/builder/handoff.js";
import { runCli } from "../src/modules/builder/run-cli.js";
import { MaterialiseService } from "../src/modules/materialise/materialise.service.js";

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`;
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const WASM_SHA256 = createHash("sha256").update(WASM).digest("hex");
const PER_JOB_PREFIXES = ["scvs-build-", "scvs-artifact-", "scvs-src-", "scvs-offline-src-"];

const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "ps") process.exit(0);
args.forEach((arg, index) => {
  if (args[index - 1] === "-v") appendFileSync(process.env.FAKE_DOCKER_MOUNTS, arg.split(":")[0] + "\\n");
});
const entrypoint = args[args.indexOf("--entrypoint") + 1];
if (args.includes("--entrypoint") && entrypoint === "rustup") { console.log("stable"); process.exit(0); }
if (args.includes("--entrypoint") && entrypoint === "cargo") process.exit(0);
if (process.env.FAKE_DOCKER_FAIL_BUILD) process.exit(1);
const mount = args.find((arg) => arg.endsWith(":/artifact"));
writeFileSync(mount.slice(0, -":/artifact".length) + "/c.wasm", Buffer.from(${JSON.stringify([...WASM])}));
console.log("Wasm File: /artifact/c.wasm");
console.log("Wasm Hash: ${WASM_SHA256}");
`;

async function boundHostPaths(): Promise<string[]> {
  const log = await readFile(process.env.FAKE_DOCKER_MOUNTS!, "utf8").catch(() => "");
  return [...new Set(log.split("\n").filter(Boolean))];
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function perJobEntries(entries: string[]): string[] {
  return entries.filter((entry) => PER_JOB_PREFIXES.some((prefix) => entry.startsWith(prefix)));
}

function stubFetch(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
  return { urls, restore: () => void (globalThis.fetch = original) };
}

describe("per-job work directories", () => {
  const saved = { ...process.env };
  let root: string;
  let fakeBin: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scvs-work-dirs-"));
    fakeBin = await mkdtemp(join(tmpdir(), "scvs-fake-docker-"));
    await writeFile(join(fakeBin, "docker"), FAKE_DOCKER);
    await chmod(join(fakeBin, "docker"), 0o755);
    process.env.PATH = `${fakeBin}:${saved.PATH}`;
    process.env.FAKE_DOCKER_MOUNTS = join(fakeBin, "mounts.log");
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(root, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  });

  async function materialisedSource(): Promise<string> {
    const sourceRoot = join(await mkdtemp(join(root, "scvs-src-")), "source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.0.0"\n');
    return sourceRoot;
  }

  async function runBuilder(jobId = JOB_ID): Promise<{ classification: string; urls: string[] }> {
    const sourceRoot = await materialisedSource();
    await writeHandoff(handoffPath(root, JOB_ID), {
      ok: true,
      schema: HANDOFF_SCHEMA,
      job_id: JOB_ID,
      source: {
        mode: "hosted_tarball",
        visibility: "public",
        workspace_path: sourceRoot,
        retained_after_verification: false,
      },
    });
    process.env.SCVS_HANDOFF_ROOT = root;
    process.env.SCVS_JOB_PARAMS_JSON = JSON.stringify({
      job_id: jobId,
      target: { network: "testnet", wasm_hash: "a".repeat(64) },
      source_ref: { type: "public_tarball", visibility: "public", tarball_sha256: "b".repeat(64) },
      image_digest: IMAGE,
      mode: "build",
      upload_url: "https://example.invalid/recipe.json?X-Amz-Signature=sig",
      artifact_upload_url: "https://example.invalid/rebuilt.wasm?X-Amz-Signature=sig",
    });

    const stub = stubFetch();
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] })],
        providers: [BuilderService],
      }).compile();
      const result = await moduleRef.get(BuilderService).run();
      return { classification: result.classification, urls: stub.urls };
    } finally {
      stub.restore();
    }
  }

  it("runCli records every directory it creates for the job", async () => {
    const workDirs: string[] = [];
    const sourceRoot = await materialisedSource();

    const result = await runCli({
      mode: "build",
      target: { network: "testnet", wasm_hash: "a".repeat(64) },
      build: { image: IMAGE, workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt: [] },
      source: { mode: "hosted_tarball", visibility: "public", workspace_path: sourceRoot, retained_after_verification: false },
      config: { cliTimeoutMs: 10_000 },
      workDirs,
    });

    expect(result.outcome).toBe("built");
    expect(workDirs.map((dir) => basename(dir).replace(/-[^-]+$/, "-")).sort()).toEqual([
      "scvs-artifact-",
      "scvs-build-",
      "scvs-offline-src-",
    ]);
    const bound = await boundHostPaths();
    expect(bound.length).toBeGreaterThan(0);
    for (const path of bound) {
      expect(workDirs.some((dir) => !relative(dir, path).startsWith(".."))).toBe(true);
    }
  });

  it("the runner uploads the rebuilt Wasm and then leaves nothing of the job behind", async () => {
    const { classification, urls } = await runBuilder();

    expect(classification).toBe("built");
    expect(urls.some((url) => url.includes("rebuilt.wasm"))).toBe(true);
    const bound = await boundHostPaths();
    expect(bound.length).toBeGreaterThan(0);
    for (const path of bound) expect(await exists(path)).toBe(false);
    expect(perJobEntries(await readdir(root))).toEqual([]);
    expect(await readdir(join(root, "scvs-handoff"))).toEqual([]);
  });

  it("the runner leaves nothing of the job behind when the build fails", async () => {
    process.env.FAKE_DOCKER_FAIL_BUILD = "1";

    const { classification } = await runBuilder();

    expect(classification).toBe("cli_failure");
    const bound = await boundHostPaths();
    expect(bound.length).toBeGreaterThan(0);
    for (const path of bound) expect(await exists(path)).toBe(false);
    expect(perJobEntries(await readdir(root))).toEqual([]);
  });

  it("a job id that is not one path segment removes no other job's handoff", async () => {
    const { classification } = await runBuilder("");

    expect(classification).toBe("fatal");
    expect(await exists(handoffPath(root, JOB_ID))).toBe(true);
  });

  async function materialiseArchive(expectedSourceSha256?: string) {
    const packageRoot = await mkdtemp(join(root, "package-"));
    await mkdir(join(packageRoot, "pkg"), { recursive: true });
    await writeFile(join(packageRoot, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    const archivePath = join(packageRoot, "counter.tar.gz");
    await runCommand(["tar", "-czf", archivePath, "-C", packageRoot, "pkg"], { mirrorOutput: false });
    const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");

    process.env.SCVS_HANDOFF_ROOT = root;
    process.env.SCVS_ARTIFACT_DIR = await mkdtemp(join(root, "artifacts-"));
    process.env.SCVS_JOB_PARAMS_JSON = JSON.stringify({
      job_id: JOB_ID,
      mode: "verify",
      source_ref: { type: "source_uri", visibility: "public", source_uri: archivePath, source_sha256: sha256 },
      ...(expectedSourceSha256 ? { expected_source_sha256: expectedSourceSha256 } : {}),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] })],
      providers: [MaterialiseService],
    }).compile();
    expect(await moduleRef.get(MaterialiseService).run()).toBe(0);
    return readHandoff(handoffPath(root, JOB_ID));
  }

  it("materialise removes its extraction root when it hands off a refusal", async () => {
    const handoff = await materialiseArchive("3".repeat(64));

    expect(handoff.ok).toBe(false);
    expect(perJobEntries(await readdir(root))).toEqual([]);
  });

  it("materialise keeps its extraction root for the runner when it hands off a source", async () => {
    const handoff = await materialiseArchive();

    expect(handoff.ok).toBe(true);
    expect(perJobEntries(await readdir(root))).toHaveLength(1);
  });
});
