import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import configuration from "../src/config/configuration.js";
import { ComposerService } from "../src/modules/composer/composer.service.js";

const PARAMS = {
  environment_id: "env-1",
  pair: { cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4", rsver: "1.96.0" },
  template_version: "v1",
  ecr_repository_uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/composed",
  upload_url: "https://example.invalid/receipt.json?X-Amz-Signature=sig",
};

async function composeEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => entry.startsWith("compose-"));
}

describe("ComposerService work directory", () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  let templateRoot: string;

  beforeEach(async () => {
    templateRoot = await mkdtemp(join(tmpdir(), "scvs-composer-templates-"));
    process.env.SCVS_COMPOSER_TEMPLATE_DIR = templateRoot;
    process.env.SCVS_COMPOSER_PARAMS_JSON = JSON.stringify(PARAMS);
  });

  afterEach(async () => {
    process.env = { ...saved };
    globalThis.fetch = originalFetch;
    await rm(templateRoot, { recursive: true, force: true });
  });

  async function compose(onUpload: () => Promise<void>): Promise<number> {
    globalThis.fetch = (async () => {
      await onUpload();
      return new Response("", { status: 200 });
    }) as typeof globalThis.fetch;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] })],
      providers: [ComposerService],
    }).compile();
    return (await moduleRef.get(ComposerService).run()).exitCode;
  }

  it("composes under SCVS_ARTIFACT_DIR and removes the workdir once the receipt is uploaded", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "scvs-composer-artifacts-"));
    process.env.SCVS_ARTIFACT_DIR = artifactDir;
    let duringUpload: string[] = [];

    try {
      const exitCode = await compose(async () => {
        duringUpload = await composeEntries(artifactDir);
      });

      expect(exitCode).toBe(0);
      expect(duringUpload).toHaveLength(1);
      expect(await readdir(artifactDir)).toEqual([]);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("falls back to the OS temp dir, not the working directory, when SCVS_ARTIFACT_DIR is empty", async () => {
    process.env.SCVS_ARTIFACT_DIR = "";
    const before = new Set(await composeEntries(tmpdir()));
    let duringUpload: string[] = [];

    const exitCode = await compose(async () => {
      duringUpload = (await composeEntries(tmpdir())).filter((entry) => !before.has(entry));
    });

    expect(exitCode).toBe(0);
    expect(duringUpload).toHaveLength(1);
    expect(await composeEntries(process.cwd())).toEqual([]);
    expect(await composeEntries(tmpdir())).not.toContain(duringUpload[0]);
  });
});
