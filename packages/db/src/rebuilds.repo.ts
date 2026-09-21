import { Inject, Injectable } from "@nestjs/common";
import {
  assertMechanismReason,
  parseSourceReference,
  type BuildMode,
  type MechanismReason,
  type SourceReference,
} from "@scvs/core";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { RebuildModel as PrismaRebuild } from "../generated/prisma/models.js";

/** A rebuild's lifecycle. See schema.prisma's `Rebuild.status` for what each means. */
export const rebuildStatuses = ["pending", "dispatching", "running", "done"] as const;
export type RebuildStatus = (typeof rebuildStatuses)[number];

/** Mirrors services/builder's `classifyRunCliOutcome` output — no new vocabulary. */
export const rebuildOutcomes = ["success", "comparison_mismatch", "cli_failure"] as const;
export type RebuildOutcome = (typeof rebuildOutcomes)[number];

export type RebuildRecord = {
  rebuildId: string;
  idempotencyKey: string;
  sourceRef: SourceReference;
  buildOptions: unknown;
  imageDigest: string;
  status: RebuildStatus;
  batchJobId?: string;
  buildMode?: BuildMode;
  mechanismReason: MechanismReason;
  outcome?: RebuildOutcome;
  runner?: string;
  rebuiltWasmHash?: string;
  errorCode?: string;
  diagnostics?: unknown;
  /**
   * The `source_sha256` this rebuild's chain section records — read once at creation and never re-read, because
   * it is immutable for a given Wasm.
   */
  chainSourceSha256?: string;
  /**
   * sha256 of the **canonical source archive** — the archive this rebuild actually built from, which is not the
   * submitted bytes when a container was peeled or a rebuilt archive was adopted.
   */
  canonicalSourceSha256?: string;
  /** Where those bytes are, when they are not the submitted ones. Absent otherwise. */
  canonicalSourceKey?: string;
  /** `BuildArtifact.source_canonicalisation` as reported. Evidence; no verdict reads it. */
  sourceCanonicalisation?: unknown;
  /** Kept because rows written before then carry it and `verdict.util.ts` still publishes it for them. */
  verifyFailureCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateRebuildInput = {
  rebuildId: string;
  idempotencyKey: string;
  sourceRef: SourceReference;
  buildOptions: unknown;
  imageDigest: string;
  /**
   * A property of the rebuild rather than of a job, because one rebuild serves every job whose recipe hashes
   * the same and there is only one build.
   */
  buildMode: BuildMode;
  mechanismReason: MechanismReason;
  /** Set only when this call **creates** the row, like `buildMode` above. */
  chainSourceSha256?: string;
};

export type MarkRebuildTerminalInput = {
  outcome: RebuildOutcome;
  runner?: string;
  rebuiltWasmHash?: string;
  errorCode?: string;
  diagnostics?: unknown;
  canonicalSourceSha256?: string;
  canonicalSourceKey?: string;
  sourceCanonicalisation?: unknown;
  /** See `verifyFailureCode` on `RebuildRecord` for the whole picture. */
  verifyFailureCode?: string;
};

/** Nothing here decides a verdict. */
@Injectable()
export class RebuildsRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<RebuildRecord | undefined> {
    const row = await this.prisma.rebuild.findUnique({ where: { idempotencyKey } });
    return row ? rowToRebuild(row) : undefined;
  }

  async getById(rebuildId: string): Promise<RebuildRecord | undefined> {
    const row = await this.prisma.rebuild.findUnique({ where: { id: rebuildId } });
    return row ? rowToRebuild(row) : undefined;
  }

  async getByBatchJobId(batchJobId: string): Promise<RebuildRecord | undefined> {
    const row = await this.prisma.rebuild.findFirst({ where: { batchJobId } });
    return row ? rowToRebuild(row) : undefined;
  }

  async create(input: CreateRebuildInput): Promise<RebuildRecord> {
    const row = await this.prisma.rebuild.create({
      data: {
        id: input.rebuildId,
        idempotencyKey: input.idempotencyKey,
        sourceRef: input.sourceRef as object,
        buildOptions: (input.buildOptions ?? {}) as object,
        imageDigest: input.imageDigest,
        buildMode: input.buildMode,
        mechanismReason: input.mechanismReason,
        ...(input.chainSourceSha256 ? { chainSourceSha256: input.chainSourceSha256 } : {}),
        status: "pending" satisfies RebuildStatus,
      },
    });
    return rowToRebuild(row);
  }

  /**
   * Find-or-create, safe against two jobs discovering the same missing recipe in one poll tick:
   * `idempotency_key` is UNIQUE, so the loser gets P2002 and re-reads the winner's row.
   */
  async findOrCreate(input: CreateRebuildInput): Promise<RebuildRecord> {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    try {
      return await this.create(input);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await this.findByIdempotencyKey(input.idempotencyKey);
        if (raced) return raced;
      }
      throw error;
    }
  }

  /** Compare-and-set claim on the right to dispatch: `pending -> dispatching`. */
  async claimForDispatch(rebuildId: string): Promise<boolean> {
    const { count } = await this.prisma.rebuild.updateMany({
      where: { id: rebuildId, status: "pending" satisfies RebuildStatus },
      data: { status: "dispatching" satisfies RebuildStatus },
    });
    return count === 1;
  }

  /** `dispatching -> running`: Batch accepted the submission and gave us its job id. */
  async markDispatched(
    rebuildId: string,
    input: { batchJobId: string; buildMode: BuildMode },
  ): Promise<void> {
    await this.prisma.rebuild.update({
      where: { id: rebuildId },
      data: {
        status: "running" satisfies RebuildStatus,
        batchJobId: input.batchJobId,
        buildMode: input.buildMode,
      },
    });
  }

  /**
   * Releases a claim that could not be turned into a dispatch (Batch `SubmitJob` threw), so the next poll tick
   * retries it rather than leaving the rebuild.
   */
  async releaseClaim(rebuildId: string): Promise<void> {
    await this.prisma.rebuild.updateMany({
      where: { id: rebuildId, status: "dispatching" satisfies RebuildStatus },
      data: { status: "pending" satisfies RebuildStatus },
    });
  }

  async markTerminal(rebuildId: string, input: MarkRebuildTerminalInput): Promise<void> {
    await this.prisma.rebuild.update({
      where: { id: rebuildId },
      data: {
        status: "done" satisfies RebuildStatus,
        outcome: input.outcome,
        ...(input.runner ? { runner: input.runner } : {}),
        ...(input.rebuiltWasmHash ? { rebuiltWasmHash: input.rebuiltWasmHash } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.diagnostics
          ? { diagnostics: input.diagnostics as object }
          : {}),
        ...(input.canonicalSourceSha256
          ? { canonicalSourceSha256: input.canonicalSourceSha256 }
          : {}),
        ...(input.canonicalSourceKey ? { canonicalSourceKey: input.canonicalSourceKey } : {}),
        ...(input.sourceCanonicalisation
          ? { sourceCanonicalisation: input.sourceCanonicalisation as object }
          : {}),
        ...(input.verifyFailureCode ? { verifyFailureCode: input.verifyFailureCode } : {}),
      },
    });
  }

  // `requeueForRetry` stood here: the verify->build fallback, as a CAS from the terminal state that authorised
  // it.

  /**
   * Gives one fresh full attempt to a rebuild that exhausted its verify->build retry and still came back
   * `cli_failure`.
   */
  async requeueStaleCliFailure(rebuildId: string, buildMode: BuildMode): Promise<boolean> {
    const { count } = await this.prisma.rebuild.updateMany({
      where: {
        id: rebuildId,
        status: "done" satisfies RebuildStatus,
        outcome: "cli_failure" satisfies RebuildOutcome,
      },
      data: {
        status: "pending" satisfies RebuildStatus,
        batchJobId: null,
        buildMode,
        outcome: null,
        runner: null,
        rebuiltWasmHash: null,
        errorCode: null,
        diagnostics: Prisma.DbNull,
        // Keeping the previous lifecycle's code would let an attempt that then *succeeds* publish
        // `metadata_backed` beside a `verify_attempt_reason` from an attempt that is no longer this rebuild's.
        verifyFailureCode: null,
        // Same reason: this attempt materialises again and writes its own.
        canonicalSourceSha256: null,
        canonicalSourceKey: null,
        sourceCanonicalisation: Prisma.DbNull,
      },
    });
    return count === 1;
  }

  /**
   * Moves a not-yet-dispatched rebuild onto the mode routing actually chose. `selectBuildMechanism` is total
   * on `"build"`, so a persisted `"verify"` cannot be a decision any live routing would make — it is a row
   * that outlived the CLI path. A CAS on `pending` because that is the one status where nothing has been
   * submitted yet: a claimed or finished rebuild's mode describes an attempt that really happened, and
   * rewriting it would make its own record untrue.
   */
  async reconcileBuildMode(rebuildId: string, buildMode: BuildMode): Promise<boolean> {
    const { count } = await this.prisma.rebuild.updateMany({
      where: {
        id: rebuildId,
        status: "pending" satisfies RebuildStatus,
        buildMode: { not: buildMode },
      },
      data: { buildMode },
    });
    return count === 1;
  }

  /** Rebuilds that were mid-`SubmitJob` when a process died — the reason `"dispatching"` is a distinct status. */
  async listStuckDispatching(): Promise<RebuildRecord[]> {
    const rows = await this.prisma.rebuild.findMany({
      where: { status: "dispatching" satisfies RebuildStatus },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(rowToRebuild);
  }

  /**
   * Rebuilds sitting in one non-terminal status since before `olderThan` — the input to
   * `scheduler/rebuild-reaper.scheduler.ts`.
   */
  async listStuckByStatus(status: RebuildStatus, olderThan: Date): Promise<RebuildRecord[]> {
    const rows = await this.prisma.rebuild.findMany({
      where: { status, updatedAt: { lt: olderThan } },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map(rowToRebuild);
  }

  /** `running -> done(cli_failure)` for a rebuild whose Batch job never reported back. */
  async markRunTimedOut(rebuildId: string, detail: string): Promise<boolean> {
    const { count } = await this.prisma.rebuild.updateMany({
      where: { id: rebuildId, status: "running" satisfies RebuildStatus },
      data: {
        status: "done" satisfies RebuildStatus,
        outcome: "cli_failure" satisfies RebuildOutcome,
        errorCode: "rebuild_timeout",
        diagnostics: { timed_out: true, stderr_excerpt: detail } as object,
      },
    });
    return count === 1;
  }

  async listByStatus(statuses: RebuildStatus[]): Promise<RebuildRecord[]> {
    if (statuses.length === 0) return [];
    const rows = await this.prisma.rebuild.findMany({
      where: { status: { in: statuses } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(rowToRebuild);
  }
}

// Same contract as jobs.repo.ts's `rowToJob`: anything derived from a raw column rather than passed straight
// through is validated here, because the DB layer has no enum types of its own.
function rowToRebuild(row: PrismaRebuild): RebuildRecord {
  return {
    rebuildId: row.id,
    idempotencyKey: row.idempotencyKey,
    sourceRef: parseSourceReference(row.sourceRef),
    buildOptions: row.buildOptions,
    imageDigest: row.imageDigest,
    status: assertRebuildStatus(row.status),
    ...(row.batchJobId ? { batchJobId: row.batchJobId } : {}),
    ...(row.buildMode ? { buildMode: assertBuildModeValue(row.buildMode) } : {}),
    mechanismReason: assertMechanismReason(row.mechanismReason),
    ...(row.outcome ? { outcome: assertRebuildOutcome(row.outcome) } : {}),
    ...(row.runner ? { runner: row.runner } : {}),
    ...(row.rebuiltWasmHash ? { rebuiltWasmHash: row.rebuiltWasmHash } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.diagnostics ? { diagnostics: row.diagnostics } : {}),
    ...(row.chainSourceSha256 ? { chainSourceSha256: row.chainSourceSha256 } : {}),
    ...(row.canonicalSourceSha256
      ? { canonicalSourceSha256: row.canonicalSourceSha256 }
      : {}),
    ...(row.canonicalSourceKey ? { canonicalSourceKey: row.canonicalSourceKey } : {}),
    ...(row.sourceCanonicalisation
      ? { sourceCanonicalisation: row.sourceCanonicalisation }
      : {}),
    ...(row.verifyFailureCode ? { verifyFailureCode: row.verifyFailureCode } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertRebuildStatus(value: string): RebuildStatus {
  if ((rebuildStatuses as readonly string[]).includes(value)) return value as RebuildStatus;
  throw new Error(`Unrecognized rebuild status in database: ${value}`);
}

function assertRebuildOutcome(value: string): RebuildOutcome {
  if ((rebuildOutcomes as readonly string[]).includes(value)) return value as RebuildOutcome;
  throw new Error(`Unrecognized rebuild outcome in database: ${value}`);
}

function assertBuildModeValue(value: string): BuildMode {
  if (value === "verify" || value === "build") return value;
  throw new Error(`Unrecognized rebuild build_mode in database: ${value}`);
}
