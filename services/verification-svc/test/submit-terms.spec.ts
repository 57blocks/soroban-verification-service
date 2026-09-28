import { jest } from "@jest/globals";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspaceRoot } from "@scvs/config";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { LegalService } from "../src/modules/legal/legal.service.js";
import { SubmitService } from "../src/modules/verifications/submit.service.js";

const examplePath = join(findWorkspaceRoot() as string, "config/legal-documents.example.json");
const prisma = createPrismaClient(readDbEnv());
const jobsRepository = new JobsRepository(prisma);
const createdRows = new CreatedRows();

afterAll(async () => {
  try {
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

/** A fresh target per case: `getActiveJobForTarget` would hand later cases the first case's non-terminal job. */
const freshTarget = () => ({ network: "testnet" as const, wasm_hash: randomBytes(32).toString("hex") });

const manifest = {
  schema: "stellar-submitted-source-verification-manifest-v1",
  source_sha256: "a".repeat(64),
  source_uri: "https://example.test/source.tar.gz",
};

async function bundleFile(mutate: (bundle: Record<string, unknown>) => void): Promise<{ path: string; sha256: string; version: string }> {
  const bundle = JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;
  mutate(bundle);
  const raw = `${JSON.stringify(bundle, null, 2)}\n`;
  const dir = await mkdtemp(join(tmpdir(), "scvs-submit-terms-"));
  const path = join(dir, "legal-documents.json");
  await writeFile(path, raw);
  return {
    path,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    version: bundle.version as string,
  };
}

async function legalFor(path: string): Promise<LegalService> {
  const service = new LegalService(
    { get: () => path } as never,
    jobsRepository as never,
  );
  await service.onModuleInit();
  return service;
}

const configStub = { get: (key: string) => (key === "activeJobDedupStaleMs" ? 30 * 60_000 : undefined) };

function submitServiceFor(legal: LegalService): SubmitService {
  return new SubmitService(
    configStub as never,
    jobsRepository as never,
    { getUpload: jest.fn(), setUploadVisibility: jest.fn() } as never,
    { recordReference: jest.fn() } as never,
    legal as never,
  );
}

describe("the terms gate on POST /verifications", () => {
  it("accepts a submission that carries nothing while the operator's text has no effective date", async () => {
    const draft = await bundleFile(() => {});
    const service = submitServiceFor(await legalFor(draft.path));

    const response = await service.submit({ target: freshTarget(), manifest, dry_run: true });

    expect(response.statusCode).toBe(202);
    const jobId = createdRows.job((response.body as { job_id: string }).job_id);
    const row = await jobsRepository.getJobById(jobId);
    expect(row?.acceptedTermsVersion).toBeUndefined();
    expect(row?.acceptedTermsSha256).toBeUndefined();
  });

  it("binds the version when one is supplied, even while unenforced", async () => {
    const draft = await bundleFile(() => {});
    const service = submitServiceFor(await legalFor(draft.path));

    const response = await service.submit({
      target: freshTarget(),
      manifest,
      dry_run: true,
      accepted_terms_version: draft.version,
    });

    expect(response.statusCode).toBe(202);
    const jobId = createdRows.job((response.body as { job_id: string }).job_id);
    const row = await jobsRepository.getJobById(jobId);
    expect(row?.acceptedTermsVersion).toBe(draft.version);
    expect(row?.acceptedTermsSha256).toBe(draft.sha256);
  });

  it("refuses a version it does not serve, whether or not enforcement is on", async () => {
    const draft = await bundleFile(() => {});
    const service = submitServiceFor(await legalFor(draft.path));

    const response = await service.submit({
      target: freshTarget(),
      manifest,
      accepted_terms_version: "2020-01-01",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: "terms_version_outdated" });
  });

  it("requires acceptance once the operator's text declares an effective date", async () => {
    const inEffect = await bundleFile((bundle) => {
      bundle.effective_date = "2026-09-15";
    });
    const service = submitServiceFor(await legalFor(inEffect.path));

    const response = await service.submit({ target: freshTarget(), manifest });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: "terms_acceptance_required" });
    expect(response.body).not.toMatchObject({ error: "invalid_request" });
  });

  it("accepts and binds the current version once in effect, and still refuses an older one", async () => {
    const inEffect = await bundleFile((bundle) => {
      bundle.effective_date = "2026-09-15";
      bundle.version = "2026-09-15";
    });
    const service = submitServiceFor(await legalFor(inEffect.path));

    const accepted = await service.submit({
      target: freshTarget(),
      manifest,
      dry_run: true,
      accepted_terms_version: "2026-09-15",
    });
    expect(accepted.statusCode).toBe(202);
    const jobId = createdRows.job((accepted.body as { job_id: string }).job_id);
    expect((await jobsRepository.getJobById(jobId))?.acceptedTermsVersion).toBe("2026-09-15");

    const stale = await service.submit({ target: freshTarget(), manifest, accepted_terms_version: "2026-01-01" });
    expect(stale.statusCode).toBe(400);
    expect(stale.body).toMatchObject({ error: "terms_version_outdated" });
  });

  it("rejects before reading the chain, and creates no row", async () => {
    const inEffect = await bundleFile((bundle) => {
      bundle.effective_date = "2026-09-15";
    });
    const jobs = { getActiveJobForTarget: jest.fn(), createJob: jest.fn() };
    // ESM allows no spy, so `chainReaderConfig()`, the preflight path's first call, throws if reached.
    const configService = {
      get: (key: string) => {
        if (key === "stellarCliPath") throw new Error("the chain was read before the terms gate ran");
        return configStub.get(key);
      },
    };
    const service = new SubmitService(
      configService as never,
      jobs as never,
      { getUpload: jest.fn(), setUploadVisibility: jest.fn() } as never,
      { recordReference: jest.fn() } as never,
      (await legalFor(inEffect.path)) as never,
    );

    const response = await service.submit({ target: freshTarget() });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: "terms_acceptance_required" });
    expect(jobs.createJob).not.toHaveBeenCalled();
  });
});

describe("changing the text produces a new version (AC7)", () => {
  it("binds jobs submitted before and after an edit to different versions", async () => {
    const first = await bundleFile((bundle) => {
      bundle.version = `spec-a-${randomUUID()}`;
    });
    const before = await submitServiceFor(await legalFor(first.path)).submit({
      target: freshTarget(),
      manifest,
      dry_run: true,
      accepted_terms_version: first.version,
    });
    const beforeId = createdRows.job((before.body as { job_id: string }).job_id);

    const second = await bundleFile((bundle) => {
      bundle.version = `spec-b-${randomUUID()}`;
      bundle.operator_name = "Edited Operator";
    });
    const after = await submitServiceFor(await legalFor(second.path)).submit({
      target: freshTarget(),
      manifest,
      dry_run: true,
      accepted_terms_version: second.version,
    });
    const afterId = createdRows.job((after.body as { job_id: string }).job_id);

    const beforeRow = await jobsRepository.getJobById(beforeId);
    const afterRow = await jobsRepository.getJobById(afterId);

    expect(beforeRow?.acceptedTermsVersion).toBe(first.version);
    expect(afterRow?.acceptedTermsVersion).toBe(second.version);
    expect(beforeRow?.acceptedTermsSha256).toBe(first.sha256);
    expect(afterRow?.acceptedTermsSha256).toBe(second.sha256);
    expect(beforeRow?.acceptedTermsVersion).not.toBe(afterRow?.acceptedTermsVersion);
  });

  it("refuses to boot when the text changed under a version a job already bound", async () => {
    const version = `spec-fixed-${randomUUID()}`;
    const original = await bundleFile((bundle) => {
      bundle.version = version;
    });
    const submitted = await submitServiceFor(await legalFor(original.path)).submit({
      target: freshTarget(),
      manifest,
      dry_run: true,
      accepted_terms_version: version,
    });
    createdRows.job((submitted.body as { job_id: string }).job_id);

    const edited = await bundleFile((bundle) => {
      bundle.version = version;
      bundle.operator_name = "Silently Edited Operator";
    });
    const service = await legalFor(edited.path);

    await expect(service.assertNoVersionConflict()).rejects.toThrow(
      /is already bound to different text/,
    );
    await expect(service.assertNoVersionConflict()).rejects.toThrow(new RegExp(original.sha256));
    await expect(service.assertNoVersionConflict()).rejects.toThrow(new RegExp(edited.sha256));
  });

  it("boots cleanly when the same text is redeployed under the same version", async () => {
    const version = `spec-same-${randomUUID()}`;
    const bundle = await bundleFile((b) => {
      b.version = version;
    });
    const submitted = await submitServiceFor(await legalFor(bundle.path)).submit({
      target: freshTarget(),
      manifest,
      dry_run: true,
      accepted_terms_version: version,
    });
    createdRows.job((submitted.body as { job_id: string }).job_id);

    await expect((await legalFor(bundle.path)).assertNoVersionConflict()).resolves.toBeUndefined();
  });
});
