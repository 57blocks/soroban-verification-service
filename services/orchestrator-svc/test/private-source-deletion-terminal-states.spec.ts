import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  DEFAULT_MAX_JOB_RETRY_ATTEMPTS,
  type FailureReason,
  type JobStatus,
  type Verdict,
} from "@scvs/core";
import {
  createPrismaClient,
  JobsRepository,
  UploadJobReferencesRepository,
  UploadsRepository,
  readDbEnv,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

const CEILING_MS = 4 * 60 * 60 * 1000;
const prisma = createPrismaClient(readDbEnv());
const jobs = new JobsRepository(prisma);
const uploads = new UploadsRepository(prisma);
const uploadJobReferences = new UploadJobReferencesRepository(prisma);
const createdRows = new CreatedRows();

function configService() {
  return {
    get: (key: string) =>
      key === "stagingSweepJobAgeCeilingMs"
        ? CEILING_MS
        : key === "maxJobRetryAttempts"
          ? DEFAULT_MAX_JOB_RETRY_ATTEMPTS
          : undefined,
  } as unknown as ConstructorParameters<typeof SourceResolutionService>[0];
}

const service = () => new SourceResolutionService(configService(), uploads, uploadJobReferences);

afterAll(async () => {
  try {
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

const contractId = () => `C${randomBytes(20).toString("hex").toUpperCase()}`;

async function seedUpload(): Promise<string> {
  const uploadId = randomUUID();
  await uploads.createUpload({
    id: uploadId,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  await uploads.markUploadReceived(uploadId, {
    path: `staging/uploads/${uploadId}/source.tar.gz`,
    filename: "source.tar.gz",
    sizeBytes: 64,
    sourceSha256: createHash("sha256").update(randomBytes(64)).digest("hex"),
  });
  createdRows.upload(uploadId);
  return uploadId;
}

async function seedPrivateJob(uploadId: string) {
  const sourceSha256 = createHash("sha256").update(randomBytes(64)).digest("hex");
  const jobId = createdRows.job(randomUUID());
  const sourceRef = {
    type: "private_tarball" as const,
    visibility: "private" as const,
    source_sha256: sourceSha256,
    tarball_sha256: sourceSha256,
    upload_id: uploadId,
  };
  await jobs.createJob({
    jobId,
    target: { network: "testnet", contract_id: contractId() },
    verificationMode: "submitted",
    sourceRef,
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      source_sha256: sourceSha256,
      upload_id: uploadId,
    } as never,
    dryRun: false,
  });
  await uploadJobReferences.recordReference(uploadId, jobId);
  return { jobId, sourceRef };
}

const TERMINAL_STATES: {
  label: string;
  status: Extract<JobStatus, "published" | "failed" | "evaluated">;
  verdict?: Verdict;
  failureReason?: FailureReason;
  retainsUpload?: boolean;
}[] = [
  { label: "published / verified", status: "published", verdict: "verified" },
  { label: "published / mismatched", status: "published", verdict: "mismatched" },
  { label: "failed / build_failed", status: "failed", failureReason: "build_failed" },
  {
    label: "failed / internal_error while Rule D can retry",
    status: "failed",
    failureReason: "internal_error",
    retainsUpload: true,
  },
  { label: "evaluated (dry run)", status: "evaluated" },
];

describe("a private upload is retained only while a terminal job still owes a retry", () => {
  for (const state of TERMINAL_STATES) {
    it(`${state.retainsUpload ? "retains" : "releases"} the upload at ${state.label}`, async () => {
      const uploadId = await seedUpload();
      const { jobId, sourceRef } = await seedPrivateJob(uploadId);

      const advanced = await jobs.advanceJob(jobId, "queued", state.status, {
        ...(state.verdict ? { verdict: state.verdict } : {}),
        ...(state.failureReason ? { failureReason: state.failureReason } : {}),
      });
      expect(advanced).toBe(true);

      expect(
        await uploadJobReferences.hasOutstandingObligation(
          uploadId,
          CEILING_MS,
          new Date(),
          DEFAULT_MAX_JOB_RETRY_ATTEMPTS
        )
      ).toBe(state.retainsUpload ?? false);

      await service().deleteStagedUpload(sourceRef);

      if (state.retainsUpload) {
        expect(await uploads.getUpload(uploadId)).toBeDefined();
      } else {
        expect(await uploads.getUpload(uploadId)).toBeUndefined();
      }
    });
  }

  it("keeps the upload while a public sibling still owes a source publish", async () => {
    const uploadId = await seedUpload();
    const { sourceRef } = await seedPrivateJob(uploadId);

    const sibling = await seedPrivateJob(uploadId);
    await prisma.job.update({
      where: { id: sibling.jobId },
      data: {
        status: "publish_pending",
        sourceRef: { ...sibling.sourceRef, visibility: "public" } as never,
        sourcePublishPendingSince: new Date(),
      },
    });

    expect(
      await uploadJobReferences.hasOutstandingObligation(
        uploadId,
        CEILING_MS,
        new Date(),
        DEFAULT_MAX_JOB_RETRY_ATTEMPTS
      )
    ).toBe(true);

    await service().deleteStagedUpload(sourceRef);

    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });
});
