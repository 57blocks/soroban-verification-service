import {
  assertBuildMode,
  assertFailureReason,
  assertJobStatus,
  assertVerdict,
  assertVerificationMode,
  failureReasons,
  isTerminalJobStatus,
  parseDto,
  parseSourceReference,
  retryableFailureReasons,
  SubmittedSourceManifest,
  VerificationResultSummary,
  VerificationTarget,
  type BuildMode,
  type FailureReason,
  type JobStatus,
  type SourceReference,
  type Verdict,
  type VerificationMode,
} from "@scvs/core";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { JobModel as PrismaJob } from "../generated/prisma/models.js";

export type StatusLinkBlockedReason = "invalid_document" | "unrepresentable" | "manual_hold";

/** `complete` includes "already there": a crash between the object write and the row update replays into it. */
export type StatusLinkOutcome =
  /** False only for a `superseded` entry; when in doubt pass true, since a missed re-sync loses the link. */
  | { state: "complete"; advancePublished: boolean }
  | { state: "pending" }
  | { state: "blocked"; reason: StatusLinkBlockedReason };

export type JobRecord = {
  jobId: string;
  status: JobStatus;
  failureReason: FailureReason | null;
  verdict: Verdict | null;
  target: VerificationTarget;
  verificationMode: VerificationMode;
  sourceRef: SourceReference;
  buildOptions: unknown;
  dryRun: boolean;
  buildLogObjectKey?: string;
  /** Never leaves this process: it is compared against, never returned on any surface. */
  buildLogTokenHash?: string;
  buildLogExpiresAt?: Date;
  buildLogHold: boolean;
  acceptedTermsVersion?: string;
  acceptedTermsSha256?: string;
  manifest?: SubmittedSourceManifest;
  result?: VerificationResultSummary;
  error?: string;
  progress?: { step: string; detail?: string };
  rebuildId?: string;
  publishAttempts: number;
  retryAttempts: number;
  archivePendingSince?: string;
  archivedTxId?: string;
  archiveAttempts: number;
  sourcePublishPendingSince?: string;
  sourceFileName?: string;
  sourcePublishAttempts: number;
  sourceArchivePendingSince?: string;
  sourceArchivedTxId?: string;
  sourceArchiveAttempts: number;
  statusLinkPendingSince?: string;
  statusLinkBlockedSince?: string;
  statusLinkBlockedReason?: StatusLinkBlockedReason;
  publishedUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type CreateJobInput = {
  jobId: string;
  target: VerificationTarget;
  verificationMode: VerificationMode;
  sourceRef: SourceReference;
  buildOptions: unknown;
  manifest: SubmittedSourceManifest;
  dryRun: boolean;
  /** sha256 of the build-log token; the token itself never reaches this layer. */
  buildLogTokenHash?: string;
  acceptedTermsVersion?: string;
  acceptedTermsSha256?: string;
};

const ACTIVE_STATUSES: JobStatus[] = [
  "queued",
  "preparing",
  "building",
  "comparing",
  "publishing",
  "publish_pending",
];

@Injectable()
export class JobsRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const row = await this.prisma.job.create({
      data: {
        id: input.jobId,
        contractId: input.target.contract_id ?? null,
        wasmHash: input.target.wasm_hash ?? null,
        network: input.target.network,
        verificationMode: input.verificationMode,
        sourceRef: input.sourceRef as object,
        buildOptions: (input.buildOptions ?? {}) as object,
        status: "queued" satisfies JobStatus,
        dryRun: input.dryRun,
        manifest: input.manifest as unknown as object,
        progressStep: "queued",
        progressDetail: "Waiting for orchestrator-svc...",
        ...(input.buildLogTokenHash ? { buildLogTokenHash: input.buildLogTokenHash } : {}),
        ...(input.acceptedTermsVersion && input.acceptedTermsSha256
          ? {
              acceptedTermsVersion: input.acceptedTermsVersion,
              acceptedTermsSha256: input.acceptedTermsSha256,
            }
          : {}),
      },
    });
    return rowToJob(row);
  }

  async getJobById(jobId: string): Promise<JobRecord | undefined> {
    const row = await this.prisma.job.findUnique({ where: { id: jobId } });
    return row ? rowToJob(row) : undefined;
  }

  async getActiveJobForTarget(
    target: VerificationTarget,
    options: {
      updatedSince?: Date;
      dryRun?: boolean;
      visibility?: "public" | "private";
      sourceSha256?: string;
    } = {},
  ): Promise<JobRecord | undefined> {
    const targetFilters = targetOrFilters(target);
    if (targetFilters.length === 0) return undefined;
    const row = await this.prisma.job.findFirst({
      where: {
        network: target.network,
        status: { in: ACTIVE_STATUSES },
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        // Without this a wedged job blocks its target's resubmissions forever.
        ...(options.updatedSince ? { updatedAt: { gte: options.updatedSince } } : {}),
        AND: [
          ...(options.visibility === undefined
            ? []
            : [{ sourceRef: { path: ["visibility"], equals: options.visibility } }]),
          ...(options.sourceSha256 === undefined
            ? []
            : [{ sourceRef: { path: ["source_sha256"], equals: options.sourceSha256 } }]),
        ],
        OR: targetFilters,
      },
      orderBy: { createdAt: "asc" },
    });
    return row ? rowToJob(row) : undefined;
  }

  async getActiveJobForWasmHash(wasmHash: string): Promise<JobRecord | undefined> {
    const row = await this.prisma.job.findFirst({
      where: { wasmHash, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: "asc" },
    });
    return row ? rowToJob(row) : undefined;
  }

  /** One conditional write that both selects and claims. */
  async advanceJob(
    jobId: string,
    from: JobStatus | JobStatus[],
    to: JobStatus,
    updates: AdvanceJobInput = {},
  ): Promise<boolean> {
    const { count } = await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: Array.isArray(from) ? from : [from] } },
      data: {
        status: to,
        completedAt: isTerminalJobStatus(to) ? new Date() : null,
        ...("failureReason" in updates ? { failureReason: updates.failureReason } : {}),
        ...("verdict" in updates ? { verdict: updates.verdict } : {}),
        ...toUpdateData(updates),
      },
    });
    if (count === 0) return false;
    await this.notifyJobUpdate(jobId);
    return true;
  }

  async claimForPublish(jobId: string): Promise<boolean> {
    return this.advanceJob(jobId, ["comparing", "publish_pending"], "publishing");
  }

  async releaseStalePublishing(olderThan: Date, only?: string[]): Promise<string[]> {
    const where = {
      status: "publishing" satisfies JobStatus,
      updatedAt: { lt: olderThan },
      ...(only ? { id: { in: only } } : {}),
    };
    const stale = await this.prisma.job.findMany({ where, select: { id: true } });
    if (stale.length === 0) return [];
    await this.prisma.job.updateMany({
      where,
      data: {
        status: "publish_pending" satisfies JobStatus,
        publishAttempts: { increment: 1 },
        completedAt: null,
      },
    });
    for (const { id } of stale) {
      await this.notifyJobUpdate(id);
    }
    return stale.map(({ id }) => id);
  }

  async updateJob(jobId: string, updates: UpdateJobInput): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: toUpdateData(updates),
    });
    await this.notifyJobUpdate(jobId);
  }

  async listJobsAttachedToRebuild(rebuildId: string): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { rebuildId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(rowToJob);
  }

  async reopenJobsFailedByRebuild(rebuildId: string, errorCode: string): Promise<string[]> {
    const where = {
      rebuildId,
      status: "failed" satisfies JobStatus,
      errorCode,
    };
    const candidates = await this.prisma.job.findMany({ where, select: { id: true } });
    if (candidates.length === 0) return [];

    const { count } = await this.prisma.job.updateMany({
      where,
      data: {
        status: "building" satisfies JobStatus,
        failureReason: null,
        verdict: null,
        errorCode: null,
        completedAt: null,
        // `Prisma.DbNull`, not `undefined`: on a `Json?` column `undefined` means "leave alone".
        resultSummary: Prisma.DbNull,
        progressStep: "building",
        progressDetail:
          "The shared rebuild was retried and this verification is being re-evaluated.",
      },
    });
    if (count === 0) return [];

    for (const { id } of candidates) {
      await this.notifyJobUpdate(id);
    }
    return candidates.map(({ id }) => id);
  }

  async requeueRetryableFailures(
    maxAttempts: number,
    eligibleSince: Date,
    only?: string[],
  ): Promise<string[]> {
    if (maxAttempts <= 0) return [];
    const retryable = [...retryableFailureReasons];
    const where = {
      status: "failed" satisfies JobStatus,
      failureReason: { in: retryable },
      retryAttempts: { lt: maxAttempts },
      updatedAt: { gte: eligibleSince },
      ...(only ? { id: { in: only } } : {}),
    };
    const candidates = await this.prisma.job.findMany({ where, select: { id: true } });
    if (candidates.length === 0) return [];

    const { count } = await this.prisma.job.updateMany({
      where,
      data: {
        status: "queued" satisfies JobStatus,
        retryAttempts: { increment: 1 },
        failureReason: null,
        completedAt: null,
        // A job can fail after `comparing` wrote a verdict, so a re-queue must clear it.
        verdict: null,
        errorCode: null,
        rebuildId: null,
        // `Prisma.DbNull`, not `undefined`: on a `Json?` column `undefined` means "leave alone".
        resultSummary: Prisma.DbNull,
        progressStep: "queued",
        progressDetail: "Retrying after a retryable failure.",
      },
    });
    if (count === 0) return [];

    for (const { id } of candidates) {
      await this.notifyJobUpdate(id);
    }
    return candidates.map(({ id }) => id);
  }

  /** Keyed on the recipe AND the hash the target deploys now, never on the recipe alone. */
  async findPublishedVerdictForRecipe(input: {
    idempotencyKey: string;
    wasmHash: string;
    excludeJobId?: string;
  }): Promise<JobRecord | undefined> {
    const row = await this.prisma.job.findFirst({
      where: {
        status: "published" satisfies JobStatus,
        wasmHash: input.wasmHash,
        publishedUpdatedAt: { not: null },
        rebuild: { idempotencyKey: input.idempotencyKey },
        ...(input.excludeJobId ? { id: { not: input.excludeJobId } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    return row ? rowToJob(row) : undefined;
  }

  async listJobsByStatus(statuses: JobStatus[]): Promise<JobRecord[]> {
    if (statuses.length === 0) return [];
    const rows = await this.prisma.job.findMany({ where: { status: { in: statuses } }, orderBy: { createdAt: "asc" } });
    return rows.map(rowToJob);
  }

  async listJobsPendingArchive(): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { archivePendingSince: { not: null } },
      orderBy: { archivePendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  async recordArchiveOutcome(
    jobId: string,
    outcome: { archived: true; txId: string; statusLink: StatusLinkOutcome } | { archived: false },
  ): Promise<void> {
    if (!outcome.archived) {
      await this.prisma.job.update({ where: { id: jobId }, data: { archiveAttempts: { increment: 1 } } });
      return;
    }
    await this.writeArchiveAndLink(jobId, "archived_tx_id", "archive_pending_since", outcome.txId, outcome.statusLink);
  }

  async listJobsPendingSourcePublish(olderThan: Date): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { sourcePublishPendingSince: { not: null, gt: olderThan } },
      orderBy: { sourcePublishPendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  async recordSourcePublishOutcome(
    jobId: string,
    outcome:
      | {
          published: true;
          sourceFileName: string;
          sourceArchivePendingSince?: Date;
          /** False on a first publish (the entry already carries the URI); true on a retry. */
          owesStatusLink: boolean;
        }
      | { published: false },
  ): Promise<void> {
    if (outcome.published) {
      // One write discharges source-publish and raises the link flag; split, a crash between loses the link.
      const now = new Date();
      const sourceArchive = outcome.sourceArchivePendingSince;
      // Only ever raises the link flag; only the pass that recomputes every link may clear it.
      const statusLink = outcome.owesStatusLink
        ? Prisma.sql`COALESCE("status_link_pending_since", ${now})`
        : Prisma.sql`"status_link_pending_since"`;
      await this.expectOneRow(this.prisma.$executeRaw`
        UPDATE "jobs" SET
          "source_publish_pending_since" = NULL,
          "source_file_name" = ${outcome.sourceFileName},
          "source_archive_pending_since" = ${sourceArchive ?? Prisma.raw('"source_archive_pending_since"')},
          "status_link_pending_since" = ${statusLink},
          "updated_at" = ${now}
        WHERE "id" = ${jobId}::uuid`, jobId);
    } else {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { sourcePublishAttempts: { increment: 1 } },
      });
    }
  }

  async listJobsPendingSourceArchive(): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { sourceArchivePendingSince: { not: null } },
      orderBy: { sourceArchivePendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  async recordSourceArchiveOutcome(
    jobId: string,
    outcome: { archived: true; txId: string; statusLink: StatusLinkOutcome } | { archived: false },
  ): Promise<void> {
    if (!outcome.archived) {
      await this.prisma.job.update({ where: { id: jobId }, data: { sourceArchiveAttempts: { increment: 1 } } });
      return;
    }
    await this.writeArchiveAndLink(
      jobId,
      "source_archived_tx_id",
      "source_archive_pending_since",
      outcome.txId,
      outcome.statusLink,
    );
  }

  /**
   * One statement, or a crash between the upload and its link loses the obligation. Raw because the
   * COALESCE (a retry must not restart the clock) is beyond Prisma's typed update.
   */
  private async writeArchiveAndLink(
    jobId: string,
    txIdColumn: "archived_tx_id" | "source_archived_tx_id",
    pendingColumn: "archive_pending_since" | "source_archive_pending_since",
    txId: string,
    statusLink: StatusLinkOutcome,
  ): Promise<void> {
    const now = new Date();
    const txIdSql = Prisma.raw(`"${txIdColumn}"`);
    const pendingSql = Prisma.raw(`"${pendingColumn}"`);
    if (statusLink.state === "complete") {
      // Never clears the link flag: it covers every link this job owes; only `recordStatusLinkOutcome` may clear it.
      await this.expectOneRow(this.prisma.$executeRaw`
        UPDATE "jobs" SET
          ${txIdSql} = ${txId},
          ${pendingSql} = NULL,
          "published_updated_at" = ${statusLink.advancePublished ? now : Prisma.raw('"published_updated_at"')},
          "updated_at" = ${now}
        WHERE "id" = ${jobId}::uuid`, jobId);
      return;
    }
    if (statusLink.state === "pending") {
      await this.expectOneRow(this.prisma.$executeRaw`
        UPDATE "jobs" SET
          ${txIdSql} = ${txId},
          ${pendingSql} = NULL,
          "status_link_pending_since" = COALESCE("status_link_pending_since", ${now}),
          "updated_at" = ${now}
        WHERE "id" = ${jobId}::uuid`, jobId);
      return;
    }
    await this.expectOneRow(this.prisma.$executeRaw`
      UPDATE "jobs" SET
        ${txIdSql} = ${txId},
        ${pendingSql} = NULL,
        "status_link_pending_since" = COALESCE("status_link_pending_since", ${now}),
        "status_link_blocked_since" = COALESCE("status_link_blocked_since", ${now}),
        "status_link_blocked_reason" = ${statusLink.reason},
        "updated_at" = ${now}
      WHERE "id" = ${jobId}::uuid`, jobId);
  }

  /** A raw UPDATE reports rows touched rather than throwing when its WHERE matched nothing. */
  private async expectOneRow(update: Promise<number>, jobId: string): Promise<void> {
    const rows = await update;
    if (rows !== 1) throw new Error(`jobs repository: expected to update job ${jobId}, updated ${rows} row(s)`);
  }

  async listJobsPendingStatusLink(): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { statusLinkPendingSince: { not: null }, statusLinkBlockedReason: null },
      orderBy: { statusLinkPendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  async countJobsBlockedStatusLink(): Promise<{ reason: StatusLinkBlockedReason; count: number }[]> {
    const grouped = await this.prisma.job.groupBy({
      by: ["statusLinkBlockedReason"],
      where: { statusLinkBlockedReason: { not: null } },
      _count: { _all: true },
    });
    return grouped.map((row) => ({
      reason: row.statusLinkBlockedReason as StatusLinkBlockedReason,
      count: row._count._all,
    }));
  }

  async recordStatusLinkOutcome(jobId: string, outcome: StatusLinkOutcome): Promise<void> {
    const now = new Date();
    if (outcome.state === "complete") {
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          statusLinkPendingSince: null,
          statusLinkBlockedSince: null,
          statusLinkBlockedReason: null,
          ...(outcome.advancePublished ? { publishedUpdatedAt: now } : {}),
        },
      });
      return;
    }
    if (outcome.state === "pending") {
      // Writes nothing: re-stamping the clock would hide how long the link has been owed.
      return;
    }
    await this.expectOneRow(this.prisma.$executeRaw`
      UPDATE "jobs" SET
        "status_link_pending_since" = COALESCE("status_link_pending_since", ${now}),
        "status_link_blocked_since" = COALESCE("status_link_blocked_since", ${now}),
        "status_link_blocked_reason" = ${outcome.reason},
        "updated_at" = ${now}
      WHERE "id" = ${jobId}::uuid`, jobId);
  }

  async clearStatusLinkBlock(jobId: string): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { statusLinkBlockedSince: null, statusLinkBlockedReason: null },
    });
  }

  /** Test cleanup only. */
  async deleteJobs(jobIds: string[]): Promise<number> {
    if (jobIds.length === 0) return 0;
    const { count } = await this.prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    return count;
  }

  /** The caller must delete each `buildLogObjectKey` object before pruning the row that points at it. */
  async listPrunableJobs(opts: { before: Date; limit: number }): Promise<PrunableJobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: {
        publishedUpdatedAt: null,
        createdAt: { lt: opts.before },
        // Redundant with publishedUpdatedAt today, but a row holding a pending obligation must never be pruned.
        archivePendingSince: null,
        sourcePublishPendingSince: null,
        sourceArchivePendingSince: null,
        statusLinkPendingSince: null,
      },
      orderBy: { createdAt: "asc" },
      take: opts.limit,
      select: { id: true, buildLogObjectKey: true },
    });
    return rows.map((row) => ({ jobId: row.id, buildLogObjectKey: row.buildLogObjectKey ?? undefined }));
  }

  /** No foreign key cascades `upload_job_references`; a shared rebuild goes only once unreferenced. */
  async pruneJobs(jobIds: string[]): Promise<number> {
    if (jobIds.length === 0) return 0;
    const rebuildIds = [
      ...new Set(
        (
          await this.prisma.job.findMany({
            where: { id: { in: jobIds }, rebuildId: { not: null } },
            select: { rebuildId: true },
          })
        ).map((row) => row.rebuildId as string),
      ),
    ];
    await this.prisma.uploadJobReference.deleteMany({ where: { jobId: { in: jobIds } } });
    const { count } = await this.prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    if (rebuildIds.length > 0) {
      await this.prisma.rebuild.deleteMany({ where: { id: { in: rebuildIds }, jobs: { none: {} } } });
    }
    return count;
  }

  async findConflictingTermsHash(version: string, contentSha256: string): Promise<string | null> {
    const row = await this.prisma.job.findFirst({
      where: {
        acceptedTermsVersion: version,
        AND: [{ acceptedTermsSha256: { not: null } }, { acceptedTermsSha256: { not: contentSha256 } }],
      },
      select: { acceptedTermsSha256: true },
    });
    return row?.acceptedTermsSha256 ?? null;
  }

  /** Key and expiry in one write: a key without an expiry is a log retained indefinitely. */
  async recordBuildLogKeyForRebuild(
    rebuildId: string,
    objectKey: string,
    expiresAt?: Date,
  ): Promise<number> {
    const { count } = await this.prisma.job.updateMany({
      where: { rebuildId },
      data: { buildLogObjectKey: objectKey, ...(expiresAt ? { buildLogExpiresAt: expiresAt } : {}) },
    });
    return count;
  }

  /** A log object is shared by a rebuild's jobs: it goes only when every one has expired and none is held. */
  async listExpiredBuildLogs(now: Date, limit: number): Promise<string[]> {
    const expired = await this.prisma.job.findMany({
      where: { buildLogObjectKey: { not: null }, buildLogExpiresAt: { lt: now } },
      select: { buildLogObjectKey: true },
      distinct: ["buildLogObjectKey"],
      orderBy: { buildLogExpiresAt: "asc" },
      take: limit,
    });
    const keys = expired.map((row) => row.buildLogObjectKey as string);
    if (keys.length === 0) return [];

    const stillOwed = await this.prisma.job.findMany({
      where: {
        buildLogObjectKey: { in: keys },
        OR: [{ buildLogHold: true }, { buildLogExpiresAt: null }, { buildLogExpiresAt: { gte: now } }],
      },
      select: { buildLogObjectKey: true },
      distinct: ["buildLogObjectKey"],
    });
    const owed = new Set(stillOwed.map((row) => row.buildLogObjectKey as string));
    return keys.filter((key) => !owed.has(key));
  }

  async expireBuildLogForJob(jobId: string): Promise<void> {
    await this.prisma.job.update({ where: { id: jobId }, data: { buildLogExpiresAt: new Date(0) } });
  }

  async countLiveBuildLogClaims(objectKey: string, now: Date): Promise<number> {
    return this.prisma.job.count({
      where: {
        buildLogObjectKey: objectKey,
        OR: [{ buildLogHold: true }, { buildLogExpiresAt: null }, { buildLogExpiresAt: { gte: now } }],
      },
    });
  }

  async clearBuildLogKey(objectKey: string): Promise<number> {
    const { count } = await this.prisma.job.updateMany({
      where: { buildLogObjectKey: objectKey },
      data: { buildLogObjectKey: null, buildLogExpiresAt: null },
    });
    return count;
  }

  // The channel must match `CHANNEL` in job-events.ts.
  private async notifyJobUpdate(jobId: string): Promise<void> {
    await this.prisma.$executeRaw`SELECT pg_notify('scvs_job_updates', ${jobId})`;
  }

  async listPublished(opts: {
    cursor?: PublishedJobCursor;
    order: "asc" | "desc";
    limit: number;
  }): Promise<PublishedJobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: {
        publishedUpdatedAt: { not: null },
        ...(opts.cursor ? publishedKeyset(opts.cursor, opts.order) : {}),
      },
      orderBy: [{ publishedUpdatedAt: opts.order }, { wasmHash: opts.order }],
      take: opts.limit,
    });
    return rows.map((row) => ({
      // Non-null: wasmHash is always set before publishedUpdatedAt can be.
      wasmHash: row.wasmHash as string,
      publishedUpdatedAt: (row.publishedUpdatedAt as Date).toISOString(),
    }));
  }
}

export type PrunableJobRecord = { jobId: string; buildLogObjectKey?: string };

export type PublishedJobCursor = { timestampMs: number; wasmHash: string };
export type PublishedJobRecord = { wasmHash: string; publishedUpdatedAt: string };

/** Prisma has no row-value comparison, so `(published_updated_at, wasm_hash)` vs the cursor is an OR expansion. */
function publishedKeyset(cursor: PublishedJobCursor, order: "asc" | "desc"): { OR: object[] } {
  const at = new Date(cursor.timestampMs);
  return order === "asc"
    ? { OR: [{ publishedUpdatedAt: { gt: at } }, { publishedUpdatedAt: at, wasmHash: { gt: cursor.wasmHash } }] }
    : { OR: [{ publishedUpdatedAt: { lt: at } }, { publishedUpdatedAt: at, wasmHash: { lt: cursor.wasmHash } }] };
}

function toUpdateData(updates: UpdateJobInput): Prisma.JobUncheckedUpdateManyInput {
  return {
    ...("wasmHash" in updates ? { wasmHash: updates.wasmHash } : {}),
    ...("result" in updates ? { resultSummary: updates.result as unknown as object } : {}),
    ...("error" in updates ? { errorCode: updates.error } : {}),
    ...("progress" in updates
      ? { progressStep: updates.progress?.step ?? null, progressDetail: updates.progress?.detail ?? null }
      : {}),
    ...("rebuildId" in updates ? { rebuildId: updates.rebuildId } : {}),
    ...("buildOptions" in updates ? { buildOptions: (updates.buildOptions ?? {}) as object } : {}),
    ...("publishAttempts" in updates ? { publishAttempts: updates.publishAttempts } : {}),
    ...("retryAttempts" in updates ? { retryAttempts: updates.retryAttempts } : {}),
    ...("archivePendingSince" in updates ? { archivePendingSince: updates.archivePendingSince } : {}),
    ...("publishedUpdatedAt" in updates ? { publishedUpdatedAt: updates.publishedUpdatedAt } : {}),
    ...("sourcePublishPendingSince" in updates
      ? { sourcePublishPendingSince: updates.sourcePublishPendingSince }
      : {}),
    ...("sourceArchivePendingSince" in updates
      ? { sourceArchivePendingSince: updates.sourceArchivePendingSince }
      : {}),
  };
}

function targetOrFilters(target: VerificationTarget): Array<Record<string, string>> {
  const filters: Array<Record<string, string>> = [];
  if (target.contract_id) filters.push({ contractId: target.contract_id });
  if (target.wasm_hash) filters.push({ wasmHash: target.wasm_hash });
  return filters;
}

/** No `status`, `failureReason` or `verdict`: those change only through a conditional transition (`advanceJob`). */
export type UpdateJobInput = Partial<{
  wasmHash: string;
  rebuildId: string | null;
  result: VerificationResultSummary;
  error: string;
  progress: { step: string; detail?: string } | undefined;
  buildOptions: unknown;
  publishAttempts: number;
  retryAttempts: number;
  archivePendingSince: Date;
  publishedUpdatedAt: Date;
  sourcePublishPendingSince: Date | null;
  sourceArchivePendingSince: Date | null;
}>;

export type AdvanceJobInput = UpdateJobInput &
  Partial<{
    failureReason: FailureReason | null;
    verdict: Verdict | null;
  }>;

function rowToJob(row: PrismaJob): JobRecord {
  return {
    jobId: row.id,
    status: assertJobStatus(row.status),
    failureReason: row.failureReason === null ? null : assertFailureReason(row.failureReason),
    verdict: row.verdict === null ? null : assertVerdict(row.verdict),
    target: parseDto(VerificationTarget, {
      network: row.network,
      ...(row.contractId ? { contract_id: row.contractId } : {}),
      ...(row.wasmHash ? { wasm_hash: row.wasmHash } : {}),
    }),
    verificationMode: assertVerificationMode(row.verificationMode),
    sourceRef: parseSourceReference(row.sourceRef),
    buildOptions: row.buildOptions,
    dryRun: row.dryRun,
    ...(row.buildLogObjectKey ? { buildLogObjectKey: row.buildLogObjectKey } : {}),
    ...(row.buildLogTokenHash ? { buildLogTokenHash: row.buildLogTokenHash } : {}),
    ...(row.buildLogExpiresAt ? { buildLogExpiresAt: row.buildLogExpiresAt } : {}),
    ...(row.acceptedTermsVersion ? { acceptedTermsVersion: row.acceptedTermsVersion } : {}),
    ...(row.acceptedTermsSha256 ? { acceptedTermsSha256: row.acceptedTermsSha256 } : {}),
    buildLogHold: row.buildLogHold,
    ...(row.manifest ? { manifest: parseDto(SubmittedSourceManifest, row.manifest) } : {}),
    ...(row.resultSummary ? { result: parseDto(VerificationResultSummary, row.resultSummary) } : {}),
    ...(row.errorCode ? { error: row.errorCode } : {}),
    ...(row.progressStep
      ? { progress: { step: row.progressStep, ...(row.progressDetail ? { detail: row.progressDetail } : {}) } }
      : {}),
    ...(row.rebuildId ? { rebuildId: row.rebuildId } : {}),
    publishAttempts: row.publishAttempts,
    retryAttempts: row.retryAttempts,
    ...(row.archivePendingSince ? { archivePendingSince: row.archivePendingSince.toISOString() } : {}),
    ...(row.statusLinkPendingSince ? { statusLinkPendingSince: row.statusLinkPendingSince.toISOString() } : {}),
    ...(row.statusLinkBlockedSince ? { statusLinkBlockedSince: row.statusLinkBlockedSince.toISOString() } : {}),
    ...(row.statusLinkBlockedReason
      ? { statusLinkBlockedReason: row.statusLinkBlockedReason as StatusLinkBlockedReason }
      : {}),
    ...(row.archivedTxId ? { archivedTxId: row.archivedTxId } : {}),
    archiveAttempts: row.archiveAttempts,
    ...(row.publishedUpdatedAt ? { publishedUpdatedAt: row.publishedUpdatedAt.toISOString() } : {}),
    ...(row.sourcePublishPendingSince
      ? { sourcePublishPendingSince: row.sourcePublishPendingSince.toISOString() }
      : {}),
    ...(row.sourceFileName ? { sourceFileName: row.sourceFileName } : {}),
    sourcePublishAttempts: row.sourcePublishAttempts,
    ...(row.sourceArchivePendingSince
      ? { sourceArchivePendingSince: row.sourceArchivePendingSince.toISOString() }
      : {}),
    ...(row.sourceArchivedTxId ? { sourceArchivedTxId: row.sourceArchivedTxId } : {}),
    sourceArchiveAttempts: row.sourceArchiveAttempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
  };
}
