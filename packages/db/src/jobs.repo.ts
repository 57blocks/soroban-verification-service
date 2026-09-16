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

/** Why automatic status-link recovery stopped. Closed here rather than in SQL: adding one is not a migration. */
export type StatusLinkBlockedReason = "invalid_document" | "unrepresentable" | "manual_hold";

/**
 * What one attempt to put a link into `wasms/<hash>.json` left behind. `complete` covers "already there"
 * too: a process dying between the object write and this row update replays into that, and a consumer
 * syncing on `published_updated_at` would never learn about the link if it counted as a no-op.
 */
export type StatusLinkOutcome =
  /**
   * `advancePublished` is false only for a `superseded` entry, where nothing changed for a consumer.
   * Anywhere ambiguous the caller says true: a needless re-sync costs one read, a missed one loses the link
   * from every consumer's view.
   */
  | { state: "complete"; advancePublished: boolean }
  | { state: "pending" }
  | { state: "blocked"; reason: StatusLinkBlockedReason };

export type JobRecord = {
  jobId: string;
  status: JobStatus;
  failureReason: FailureReason | null;
  /** Null until `comparing` computes it, and null forever on a job-level failure. */
  verdict: Verdict | null;
  target: VerificationTarget;
  verificationMode: VerificationMode;
  sourceRef: SourceReference;
  buildOptions: unknown;
  /** The verdict is returned to the submitter and nothing is written to the result root. */
  dryRun: boolean;
  /** Absent until the sandbox-side work that stores the redacted build output writes it. */
  buildLogObjectKey?: string;
  /** Never leaves this process: it is compared against, never returned on any surface. */
  buildLogTokenHash?: string;
  buildLogExpiresAt?: Date;
  buildLogHold: boolean;
  /** The terms version this job's submitter accepted, and the hash of the bytes served under it. */
  acceptedTermsVersion?: string;
  acceptedTermsSha256?: string;
  manifest?: SubmittedSourceManifest;
  result?: VerificationResultSummary;
  error?: string;
  progress?: { step: string; detail?: string };
  /**
   * Absent until `services/orchestrator-svc` finds-or-creates it on the job's first poll tick — the job row
   * itself is created before any rebuild lookup happens.
   */
  rebuildId?: string;
  /** Failed attempts at publishing this job's verdict — see schema.prisma's `publish_attempts`. */
  publishAttempts: number;
  retryAttempts: number;
  /** Presence (non-`undefined`) is the durable pending flag AP4 requires. */
  archivePendingSince?: string;
  /** Set once the archive upload succeeds. Presence means "done". */
  archivedTxId?: string;
  /** Failed archive attempts — see schema.prisma's `archive_attempts`. No abandonment ceiling. */
  archiveAttempts: number;
  /** Set the moment a public job's first publish attempt fails; cleared once the source durably lands. */
  sourcePublishPendingSince?: string;
  /** Set once this job's source is durably written to `sources/{sha256}{ext}`. */
  sourceFileName?: string;
  /**
   * Failed source-publish attempts, recorded for observability — see `sourcePublishPendingSince` for what
   * actually bounds retry.
   */
  sourcePublishAttempts: number;
  /**
   * The archive obligation for THIS job's own public, mainnet source (mainnet-source-archive design.md MSA-2) —
   * independent of `archivePendingSince` above.
   */
  sourceArchivePendingSince?: string;
  /** Set once the source archive upload succeeds. Presence means "done". */
  sourceArchivedTxId?: string;
  /** Failed source-archive attempts — see schema.prisma's `source_archive_attempts`. */
  sourceArchiveAttempts: number;
  /** At least one link this job owes `wasms/<hash>.json` is not in the document yet. */
  statusLinkPendingSince?: string;
  /** Set alongside the reason when automatic link recovery stops; blocked rows still owe the link. */
  statusLinkBlockedSince?: string;
  /** Why automatic recovery stopped — a closed set, never raw error text. */
  statusLinkBlockedReason?: StatusLinkBlockedReason;
  /**
   * Written by `report-artifact`'s `writePublication` on first publish, advanced by `archive-and-recovery`'s
   * `appendArchiveReference` on a real archive-backfill write.
   */
  publishedUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** When this job reached a terminal status. Absent in flight, and on rows predating the column. */
  completedAt?: string;
};

export type CreateJobInput = {
  jobId: string;
  target: VerificationTarget;
  verificationMode: VerificationMode;
  sourceRef: SourceReference;
  buildOptions: unknown;
  manifest: SubmittedSourceManifest;
  /** No default: whether a job publishes its verdict is not something a caller should omit. */
  dryRun: boolean;
  /**
   * sha256 of the token that will authorise this job's raw build log (build-log-access design.md BL-1). The
   * token itself never reaches this layer. Absent means no token was minted, and no request can ever read
   * this job's raw log — which is what every job created before build-log tokens existed is.
   */
  buildLogTokenHash?: string;
  /**
   * The accepted terms version and the sha256 of the bytes served under it
   * (versioned-terms-and-assent design.md TA-3). Absent together, never one without the other: absent means
   * the submitter accepted nothing, which is what TA-7's unenforced regime produces.
   */
  acceptedTermsVersion?: string;
  acceptedTermsSha256?: string;
};

// Non-terminal, for `getActiveJobForTarget`'s "you already asked for this" check.
const ACTIVE_STATUSES: JobStatus[] = [
  "queued",
  "preparing",
  "building",
  "comparing",
  "publishing",
  "publish_pending",
];

/**
 * CRUD over the `jobs` table — operational/dedup state. S3 remains the public source of truth; see
 * packages/db/prisma/schema.prisma.
 */
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

  /** Jobs still in flight for this exact target — the "you already asked for this" check on submit. */
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
        // Without it a single wedged job blocks its target's resubmissions *forever*: the statuses above are
        // non-terminal, `orderBy createdAt asc` deterministically returns the OLDEST match, and nothing ages a
        // row out.
        ...(options.updatedSince ? { updatedAt: { gte: options.updatedSince } } : {}),
        // `visibility` and `source_sha256` are part of the question for exactly the reason `dryRun` above is,
        // and leaving them out of it was the defect:
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

  /** Oldest first, matching the submit-side lookup. */
  async getActiveJobForWasmHash(wasmHash: string): Promise<JobRecord | undefined> {
    const row = await this.prisma.job.findFirst({
      where: { wasmHash, status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: "asc" },
    });
    return row ? rowToJob(row) : undefined;
  }

  /** DB1's claim, and every transition after it: **one conditional write that both selects and claims**. */
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
        // Same write as the status, so they cannot diverge. The `null` arm is the clear-on-reopen case:
        // transitioning to a non-terminal status means this job is no longer finished.
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

  /**
   * `publish_pending -> publishing`. The recovery scan's claim: exactly one scan — in this process or another
   * replica's — drives any given retry.
   */
  async claimForPublish(jobId: string): Promise<boolean> {
    // Both states a publication can legitimately be acquired from: `comparing`, where the pipeline has just
    // written the verdict, and `publish_pending`, where the recovery scan finds it.
    return this.advanceJob(jobId, ["comparing", "publish_pending"], "publishing");
  }

  /** `publishing -> publish_pending` for a row whose worker died mid-publication. */
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
      // `publishAttempts` is otherwise only incremented by `recordPublishFailure`, i.e. only when
      // `writePublication` *throws*.
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

  /**
   * Every job whose verdict is computed from this rebuild — i.e. everyone who has to be resolved (or failed)
   * when it goes terminal.
   */
  async listJobsAttachedToRebuild(rebuildId: string): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { rebuildId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(rowToJob);
  }

  /**
   * Re-opens jobs failed by a rebuild that has since been revived for a fresh attempt
   * (`RebuildsRepository.requeueStaleCliFailure`).
   */
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
        // `building` is "waiting on the rebuild", which is what these jobs are doing.
        status: "building" satisfies JobStatus,
        failureReason: null,
        verdict: null,
        errorCode: null,
        // Back into flight: a running job must not report when it finished.
        completedAt: null,
        // `Prisma.DbNull`, not `undefined`: on a `Json?` column `undefined` means "leave alone", which would
        // keep the stale build_failed summary and make the job invisible to the dispatch loop.
        resultSummary: Prisma.DbNull,
        progressStep: "building",
        progressDetail:
          "The shared rebuild was retried and this verification is being re-evaluated.",
      },
    });
    if (count === 0) return [];

    // One NOTIFY per re-opened job so any open SSE stream sees it leave its terminal state.
    for (const { id } of candidates) {
      await this.notifyJobUpdate(id);
    }
    return candidates.map(({ id }) => id);
  }

  /** Returns the ids re-queued. */
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
        // Re-queued means not finished; the next terminal transition records a new instant.
        completedAt: null,
        // Cleared for the same reason `reopenJobsFailedByRebuild` clears it: a job can reach `failed` *after*
        // `comparing` wrote a verdict (`comparison_not_available` is the live path), and a re-queued job
        // carrying a stale verdict is a row that lies until the next comparison overwrites it.
        verdict: null,
        errorCode: null,
        rebuildId: null,
        // `Prisma.DbNull`, not `undefined`: on a `Json?` column `undefined` means "leave alone", which would
        // keep the stale failure summary — the same trap `reopenJobsFailedByRebuild` documents.
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

  /**
   * Keyed on the recipe (through `rebuilds.idempotency_key`) AND on the hash the caller's target deploys *right
   * now*, never on the recipe alone.
   */
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

  /**
   * `archivePendingSince` non-null is durable state, so this survives a process restart the way an in-process
   * `Set` never could (AP4).
   */
  async listJobsPendingArchive(): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { archivePendingSince: { not: null } },
      orderBy: { archivePendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  /**
   * Records the outcome of one archive attempt. The upload and its link are separate facts and are written
   * together: an upload that happened is recorded as `archivedTxId` even when its link did not land, because
   * discarding a paid-for tx_id to express "the link is missing" is a lie in the other direction.
   */
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

  /**
   * Unlike `listJobsPendingArchive` this bounds retry to `olderThan` (caller passes `now - 24h`): a
   * source-publish retry's input is the staged upload, which can be permanently gone, so retrying forever would
   * waste scheduler cycles on a target that will never come back.
   */
  async listJobsPendingSourcePublish(olderThan: Date): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { sourcePublishPendingSince: { not: null, gt: olderThan } },
      orderBy: { sourcePublishPendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  /** Records the outcome of one source-publish attempt. */
  async recordSourcePublishOutcome(
    jobId: string,
    outcome:
      | {
          published: true;
          sourceFileName: string;
          sourceArchivePendingSince?: Date;
          /**
           * Whether the document still has to be told about this source. False on a first publish, which
           * wrote the URI into the entry it was building; true on a retry, which is amending a document that
           * was written without it.
           */
          owesStatusLink: boolean;
        }
      | { published: false },
  ): Promise<void> {
    if (outcome.published) {
      // The link obligation is created in the same write that discharges the source-publish one. Setting it
      // afterwards leaves a window where the old obligation is gone and the new one is not yet written down,
      // and a crash there loses the link for good — the pattern this whole change exists to remove.
      const now = new Date();
      const sourceArchive = outcome.sourceArchivePendingSince;
      // Never clears the link flag, only raises it — clearing belongs to the pass that recomputed every link.
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

  /**
   * Jobs with an outstanding source-archive obligation (mainnet-source-archive design.md MSA-2) — the
   * reconciliation scan's query.
   */
  async listJobsPendingSourceArchive(): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { sourceArchivePendingSince: { not: null } },
      orderBy: { sourceArchivePendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  /** Records the outcome of one source-archive attempt (live or reconciliation-scan retry). */
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
   * ONE statement: a crash between recording the upload and recording the link it owes loses the obligation
   * for good, since nothing would scan the row again.
   *
   * Raw because `status_link_pending_since` needs COALESCE — a retry must not restart the clock — which
   * Prisma's typed update cannot express.
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
      // Deliberately leaves the status-link columns alone. One flag covers every link this job owes, and a
      // job's report archive and source archive run concurrently — clearing it here because THIS link landed
      // would discharge an obligation another link is still holding, and the scan would never look again.
      // Only `recordStatusLinkOutcome`, which recomputes every link from the row, may clear it.
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

  /**
   * A raw UPDATE reports rows touched instead of throwing on a `WHERE` that matched nothing, so a job deleted
   * mid-flight would read as a successful write. These statements each address one row by id.
   */
  private async expectOneRow(update: Promise<number>, jobId: string): Promise<void> {
    const rows = await update;
    if (rows !== 1) throw new Error(`jobs repository: expected to update job ${jobId}, updated ${rows} row(s)`);
  }

  /**
   * Jobs still owing a link and not held for a human. No time bound, unlike the source-publish scan: every
   * input this replay needs — the report URL, the tx ids, the source file name — is durable.
   */
  async listJobsPendingStatusLink(): Promise<JobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: { statusLinkPendingSince: { not: null }, statusLinkBlockedReason: null },
      orderBy: { statusLinkPendingSince: "asc" },
    });
    return rows.map(rowToJob);
  }

  /** Jobs held for a human, by reason — the gauge the recovery scan cannot see from its own query. */
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

  /**
   * The recovery scan's counterpart to `recordArchiveOutcome`'s link half. It only ever runs on a row that
   * already owes the link, so `complete` always advances `published_updated_at`: the link is in the document
   * now and was not before, whether this attempt wrote it or found it already there.
   */
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
      // Deliberately writes nothing: the row already owes the link, and re-stamping the clock would hide how
      // long it has been owed.
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

  /** Puts a blocked job back in the recovery scan, keeping the clock that says how long the link has been owed. */
  async clearStatusLinkBlock(jobId: string): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { statusLinkBlockedSince: null, statusLinkBlockedReason: null },
    });
  }

  /** Removes specific jobs by id. **Test cleanup only**. */
  async deleteJobs(jobIds: string[]): Promise<number> {
    if (jobIds.length === 0) return 0;
    const { count } = await this.prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    return count;
  }

  /**
   * Jobs old enough to prune: never published, and owing nothing
   * (retention-and-pseudonymisation design.md RP-3). `publishedUpdatedAt` is the line rather than `status`
   * because it, and only it, is what `listPublished` — and therefore a consumer's incremental sync — reads.
   *
   * Returns `buildLogObjectKey` alongside the id: the caller must delete that object before the row that
   * points at it, and re-reading would be a second query for rows it just held.
   */
  async listPrunableJobs(opts: { before: Date; limit: number }): Promise<PrunableJobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: {
        publishedUpdatedAt: null,
        createdAt: { lt: opts.before },
        // A durable pending flag is an obligation; deleting the row holding one destroys it rather than
        // discharging it. Such a job is published anyway and already excluded — this states the rule.
        archivePendingSince: null,
        sourcePublishPendingSince: null,
        sourceArchivePendingSince: null,
        // Blocked refines pending, so this one column covers a held job too.
        statusLinkPendingSince: null,
      },
      orderBy: { createdAt: "asc" },
      take: opts.limit,
      select: { id: true, buildLogObjectKey: true },
    });
    return rows.map((row) => ({ jobId: row.id, buildLogObjectKey: row.buildLogObjectKey ?? undefined }));
  }

  /**
   * Deletes the jobs, the `upload_job_references` rows carrying their ids (no foreign key cascades them), and
   * any rebuild the last referencing job just took with it (ADR-008 — a rebuild is shared). Same ordering as
   * `@scvs/db/testing`'s `CreatedRows.cleanup`, for the same reason.
   */
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

  /**
   * The hash a job already bound to `version`, when it differs from `contentSha256` — i.e. the operator
   * edited the text without moving the version (versioned-terms-and-assent design.md TA-5).
   *
   * This is why the feature needs no `terms_versions` table: the property worth enforcing is that no job row
   * asserts a version whose text has changed, and the rows themselves answer that. An edit under a fixed
   * version stays undetected until one job has bound it, which is exactly when it starts mattering.
   */
  async findConflictingTermsHash(version: string, contentSha256: string): Promise<string | null> {
    const row = await this.prisma.job.findFirst({
      where: {
        acceptedTermsVersion: version,
        // Both clauses, rather than one `not`: `createJob` writes the pair together so a null hash cannot
        // occur here, and spelling it out keeps the query correct whatever `not`'s null semantics are.
        AND: [{ acceptedTermsSha256: { not: null } }, { acceptedTermsSha256: { not: contentSha256 } }],
      },
      select: { acceptedTermsSha256: true },
    });
    return row?.acceptedTermsSha256 ?? null;
  }

  /**
   * Records where a rebuild's build log was written, on **every** job attached to that rebuild — and, in the
   * same write, when that log stops being served (build-log-access design.md BL-2). One write, because a key
   * without an expiry is a log retained indefinitely, which is the state this ticket exists to end.
   */
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

  /**
   * Distinct log objects every one of whose jobs has expired and none of which is held
   * (build-log-access design.md BL-2). A rebuild is shared between jobs (ADR-008) and they share one object,
   * so the object may only go when the LAST job pointing at it has expired — the same rule
   * `UploadJobReferencesRepository.hasOutstandingObligation` applies to staged uploads.
   */
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

    // One query for every key: a job that is held, or whose expiry has not arrived, keeps the whole object.
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

  /** One job stops claiming the shared object — early deletion by its own token holder (BL-3). */
  async expireBuildLogForJob(jobId: string): Promise<void> {
    await this.prisma.job.update({ where: { id: jobId }, data: { buildLogExpiresAt: new Date(0) } });
  }

  /** How many jobs still hold a live claim on this object — a held one counts, an expired one does not. */
  async countLiveBuildLogClaims(objectKey: string, now: Date): Promise<number> {
    return this.prisma.job.count({
      where: {
        buildLogObjectKey: objectKey,
        OR: [{ buildLogHold: true }, { buildLogExpiresAt: null }, { buildLogExpiresAt: { gte: now } }],
      },
    });
  }

  /** Clears the pointer on every job that shared a deleted object, so a later read is `410`, not a 502. */
  async clearBuildLogKey(objectKey: string): Promise<number> {
    const { count } = await this.prisma.job.updateMany({
      where: { buildLogObjectKey: objectKey },
      data: { buildLogObjectKey: null, buildLogExpiresAt: null },
    });
    return count;
  }

  // Pushes to services/verification-svc's SSE stream (job-events.ts's `JobEventsService`).
  private async notifyJobUpdate(jobId: string): Promise<void> {
    await this.prisma.$executeRaw`SELECT pg_notify('scvs_job_updates', ${jobId})`;
  }

  /**
   * Prisma has no row-value comparison, so `(published_updated_at, wasm_hash) > (cursor)` is the `OR` expansion
   * in `publishedKeyset` below.
   */
  async listPublished(opts: {
    cursor?: PublishedJobCursor;
    order: "asc" | "desc";
    limit: number;
  }): Promise<PublishedJobRecord[]> {
    const rows = await this.prisma.job.findMany({
      where: {
        // `wasmHash` is always resolved and persisted before `publishedUpdatedAt` can ever be set on the same
        // row (a job that cannot resolve one fails with `missing_wasm_hash` long before reaching `published`),
        // so filtering on this column alone already excludes every row an added `wasmHash: { not: null }` would
        // have.
        publishedUpdatedAt: { not: null },
        ...(opts.cursor ? publishedKeyset(opts.cursor, opts.order) : {}),
      },
      orderBy: [{ publishedUpdatedAt: opts.order }, { wasmHash: opts.order }],
      take: opts.limit,
    });
    return rows.map((row) => ({
      // Narrowed by the `where` clause above (wasmHash is always set by the time publishedUpdatedAt is), not by
      // Prisma's return type.
      wasmHash: row.wasmHash as string,
      publishedUpdatedAt: (row.publishedUpdatedAt as Date).toISOString(),
    }));
  }
}

export type PrunableJobRecord = { jobId: string; buildLogObjectKey?: string };

export type PublishedJobCursor = { timestampMs: number; wasmHash: string };
export type PublishedJobRecord = { wasmHash: string; publishedUpdatedAt: string };

/**
 * `(published_updated_at, wasm_hash) > (cursor)` (asc) / `<` (desc) — Prisma has no row-value comparison, so
 * this is the `OR` expansion.
 */
function publishedKeyset(cursor: PublishedJobCursor, order: "asc" | "desc"): { OR: object[] } {
  const at = new Date(cursor.timestampMs);
  return order === "asc"
    ? { OR: [{ publishedUpdatedAt: { gt: at } }, { publishedUpdatedAt: at, wasmHash: { gt: cursor.wasmHash } }] }
    : { OR: [{ publishedUpdatedAt: { lt: at } }, { publishedUpdatedAt: at, wasmHash: { lt: cursor.wasmHash } }] };
}

/** The non-status half of a write, shared by `updateJob` and `advanceJob` so the two cannot drift. */
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

/**
 * Fields any write may set. `status`, `failureReason` and `verdict` are deliberately **absent**: a status write
 * that is not a conditional transition is exactly what DB1 forbids, and the other two only ever change at one.
 */
export type UpdateJobInput = Partial<{
  wasmHash: string;
  /** `null` clears the link to the shared rebuild; `undefined` would leave it alone (Prisma). */
  rebuildId: string | null;
  result: VerificationResultSummary;
  error: string;
  progress: { step: string; detail?: string } | undefined;
  buildOptions: unknown;
  publishAttempts: number;
  retryAttempts: number;
  /**
   * Set by `writePublication` the moment a report publishes — see `recordArchiveOutcome` for the two ways this
   * later resolves.
   */
  archivePendingSince: Date;
  /**
   * Advancing it again on archive backfill goes through `recordArchiveOutcome`'s own `publishedUpdatedAt`
   * parameter, not this generic path.
   */
  publishedUpdatedAt: Date;
  /**
   * Set by `writePublication` the moment a public job's first source-publish attempt fails; `null` to clear it
   * explicitly.
   */
  sourcePublishPendingSince: Date | null;
  /**
   * Set by `writePublication` or `retryPendingSourcePublish` the moment a public, mainnet job's source is
   * durably published (mainnet-source-archive design.md MSA-1/MSA-2).
   */
  sourceArchivePendingSince: Date | null;
}>;

/** What a transition may write alongside the status change itself. */
export type AdvanceJobInput = UpdateJobInput &
  Partial<{
    failureReason: FailureReason | null;
    verdict: Verdict | null;
  }>;

// Every field derived from a raw Prisma column (rather than passed straight through) is run through its
// `@scvs/core` class-validator class/guard here.
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
