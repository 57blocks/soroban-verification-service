import { Inject, Injectable } from "@nestjs/common";
import { isBuildArchitecture } from "@scvs/core";
import type { BuildArchitecture, ComposedEnvironmentRecipe } from "@scvs/core";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { EnvironmentModel as PrismaEnvironment } from "../generated/prisma/models.js";

// Consumed by orchestrator-svc's `build-environments` module.

/** An environment's lifecycle. */
export const environmentStatuses = ["pending", "composing", "ready", "failed"] as const;
export type EnvironmentStatus = (typeof environmentStatuses)[number];

export type EnvironmentRecord = {
  environmentId: string;
  cliver: string;
  rsver: string;
  templateVersion: string;
  status: EnvironmentStatus;
  recipeSha256?: string;
  imageDigest?: string;
  recipe?: ComposedEnvironmentRecipe;
  errorCode?: string;
  batchJobId?: string;
  arch?: BuildArchitecture;
  createdAt: string;
  updatedAt: string;
};

export type CreateEnvironmentInput = {
  environmentId: string;
  cliver: string;
  rsver: string;
  templateVersion: string;
};

export type MarkEnvironmentReadyInput = {
  recipeSha256: string;
  imageDigest: string;
  recipe: ComposedEnvironmentRecipe;
  /** See `ComposerArtifact.image_architecture`. */
  arch?: BuildArchitecture;
};

/**
 * CRUD over the `environments` table — one row per distinct `(cliver, rsver, template_version)`, shared by
 * every `Rebuild` whose cli-legacy recipe happens to need that composed environment.
 */
@Injectable()
export class EnvironmentsRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async findByPair(
    cliver: string,
    rsver: string,
    templateVersion: string,
  ): Promise<EnvironmentRecord | undefined> {
    const row = await this.prisma.environment.findUnique({
      where: { cliver_rsver_templateVersion: { cliver, rsver, templateVersion } },
    });
    return row ? rowToEnvironment(row) : undefined;
  }

  async getById(environmentId: string): Promise<EnvironmentRecord | undefined> {
    const row = await this.prisma.environment.findUnique({ where: { id: environmentId } });
    return row ? rowToEnvironment(row) : undefined;
  }

  /**
   * `findUnique`, because `recipe_sha256` carries a unique index — see `schema.prisma`'s note on why it is
   * genuinely unique by construction.
   */
  async findByRecipeSha256(recipeSha256: string): Promise<EnvironmentRecord | undefined> {
    const row = await this.prisma.environment.findUnique({ where: { recipeSha256 } });
    return row ? rowToEnvironment(row) : undefined;
  }

  /** The lookup a Batch terminal event arrives with — mirrors `RebuildsRepository.getByBatchJobId`. */
  async getByBatchJobId(batchJobId: string): Promise<EnvironmentRecord | undefined> {
    const row = await this.prisma.environment.findFirst({ where: { batchJobId } });
    return row ? rowToEnvironment(row) : undefined;
  }

  async create(input: CreateEnvironmentInput): Promise<EnvironmentRecord> {
    const row = await this.prisma.environment.create({
      data: {
        id: input.environmentId,
        cliver: input.cliver,
        rsver: input.rsver,
        templateVersion: input.templateVersion,
        status: "pending" satisfies EnvironmentStatus,
      },
    });
    return rowToEnvironment(row);
  }

  /** Find-or-create, safe against two jobs discovering the same missing pair in the same poll tick. */
  async findOrCreate(input: CreateEnvironmentInput): Promise<EnvironmentRecord> {
    const existing = await this.findByPair(input.cliver, input.rsver, input.templateVersion);
    if (existing) return existing;
    try {
      return await this.create(input);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findByPair(input.cliver, input.rsver, input.templateVersion);
        if (raced) return raced;
      }
      throw error;
    }
  }

  /** Compare-and-set claim on the right to compose: `pending -> composing`. */
  async claimForComposing(environmentId: string): Promise<boolean> {
    const { count } = await this.prisma.environment.updateMany({
      where: { id: environmentId, status: "pending" satisfies EnvironmentStatus },
      data: { status: "composing" satisfies EnvironmentStatus, batchJobId: null },
    });
    return count === 1;
  }

  /** Records the `scvs-composer` Batch job id once submitted — mirrors `Rebuild`'s own dispatch record. */
  async markComposing(environmentId: string, batchJobId: string): Promise<void> {
    await this.prisma.environment.update({
      where: { id: environmentId },
      data: { batchJobId },
    });
  }

  /**
   * Releases a claim that could not be turned into a dispatch (Batch `SubmitJob` threw), so the next poll tick
   * retries it rather than leaving the pair.
   */
  async releaseClaim(environmentId: string): Promise<void> {
    await this.prisma.environment.updateMany({
      where: { id: environmentId, status: "composing" satisfies EnvironmentStatus },
      data: { status: "pending" satisfies EnvironmentStatus },
    });
  }

  /** `composing -> ready`. */
  async markReady(environmentId: string, input: MarkEnvironmentReadyInput): Promise<void> {
    await this.prisma.environment.update({
      where: { id: environmentId },
      data: {
        status: "ready" satisfies EnvironmentStatus,
        recipeSha256: input.recipeSha256,
        imageDigest: input.imageDigest,
        recipe: input.recipe as object,
        arch: input.arch ?? null,
        errorCode: null,
      },
    });
  }

  /** `composing -> failed`. */
  async markFailed(environmentId: string, errorCode: string): Promise<void> {
    await this.prisma.environment.update({
      where: { id: environmentId },
      data: { status: "failed" satisfies EnvironmentStatus, errorCode },
    });
  }

  /** Every `failed` row carrying `errorCode` — the input to a deliberate recovery, never to a timer. */
  async listFailedByErrorCode(errorCode: string): Promise<EnvironmentRecord[]> {
    const rows = await this.prisma.environment.findMany({
      where: { status: "failed" satisfies EnvironmentStatus, errorCode },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map(rowToEnvironment);
  }

  /** `failed -> pending`, so the poll loop composes the pair again from scratch. */
  async resetFailedToPending(environmentId: string, expectedErrorCode: string): Promise<boolean> {
    const result = await this.prisma.environment.updateMany({
      where: { id: environmentId, status: "failed" satisfies EnvironmentStatus, errorCode: expectedErrorCode },
      data: { status: "pending" satisfies EnvironmentStatus, errorCode: null, batchJobId: null },
    });
    return result.count === 1;
  }

  /** Environments sitting in one status since before `olderThan` — the input to `EnvironmentReconcilerScheduler`. */
  async listStuckByStatus(status: EnvironmentStatus, olderThan: Date): Promise<EnvironmentRecord[]> {
    const rows = await this.prisma.environment.findMany({
      where: { status, updatedAt: { lt: olderThan } },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map(rowToEnvironment);
  }
}

// Same contract as rebuilds.repo.ts's rowToRebuild: anything derived from a raw column rather than passed
// straight through is validated here, because the DB layer has no enum types of its own.
function rowToEnvironment(row: PrismaEnvironment): EnvironmentRecord {
  return {
    environmentId: row.id,
    cliver: row.cliver,
    rsver: row.rsver,
    templateVersion: row.templateVersion,
    status: assertEnvironmentStatus(row.status),
    ...(row.recipeSha256 ? { recipeSha256: row.recipeSha256 } : {}),
    ...(row.imageDigest ? { imageDigest: row.imageDigest } : {}),
    ...(row.recipe ? { recipe: row.recipe as unknown as ComposedEnvironmentRecipe } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.batchJobId ? { batchJobId: row.batchJobId } : {}),
    ...(isBuildArchitecture(row.arch) ? { arch: row.arch } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertEnvironmentStatus(value: string): EnvironmentStatus {
  if ((environmentStatuses as readonly string[]).includes(value)) return value as EnvironmentStatus;
  throw new Error(`Unrecognized environment status in database: ${value}`);
}
