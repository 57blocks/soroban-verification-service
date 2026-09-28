import { Inject, Injectable } from "@nestjs/common";
import { isBuildArchitecture } from "@scvs/core";
import type { BuildArchitecture, ComposedEnvironmentRecipe } from "@scvs/core";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { EnvironmentModel as PrismaEnvironment } from "../generated/prisma/models.js";

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
  arch?: BuildArchitecture;
};

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

  async findByRecipeSha256(recipeSha256: string): Promise<EnvironmentRecord | undefined> {
    const row = await this.prisma.environment.findUnique({ where: { recipeSha256 } });
    return row ? rowToEnvironment(row) : undefined;
  }

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

  async claimForComposing(environmentId: string): Promise<boolean> {
    const { count } = await this.prisma.environment.updateMany({
      where: { id: environmentId, status: "pending" satisfies EnvironmentStatus },
      data: { status: "composing" satisfies EnvironmentStatus, batchJobId: null },
    });
    return count === 1;
  }

  async markComposing(environmentId: string, batchJobId: string): Promise<void> {
    await this.prisma.environment.update({
      where: { id: environmentId },
      data: { batchJobId },
    });
  }

  async releaseClaim(environmentId: string): Promise<void> {
    await this.prisma.environment.updateMany({
      where: { id: environmentId, status: "composing" satisfies EnvironmentStatus },
      data: { status: "pending" satisfies EnvironmentStatus },
    });
  }

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

  async markFailed(environmentId: string, errorCode: string): Promise<void> {
    await this.prisma.environment.update({
      where: { id: environmentId },
      data: { status: "failed" satisfies EnvironmentStatus, errorCode },
    });
  }

  async listFailedByErrorCode(errorCode: string): Promise<EnvironmentRecord[]> {
    const rows = await this.prisma.environment.findMany({
      where: { status: "failed" satisfies EnvironmentStatus, errorCode },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map(rowToEnvironment);
  }

  async resetFailedToPending(environmentId: string, expectedErrorCode: string): Promise<boolean> {
    const result = await this.prisma.environment.updateMany({
      where: { id: environmentId, status: "failed" satisfies EnvironmentStatus, errorCode: expectedErrorCode },
      data: { status: "pending" satisfies EnvironmentStatus, errorCode: null, batchJobId: null },
    });
    return result.count === 1;
  }

  async listStuckByStatus(status: EnvironmentStatus, olderThan: Date): Promise<EnvironmentRecord[]> {
    const rows = await this.prisma.environment.findMany({
      where: { status, updatedAt: { lt: olderThan } },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map(rowToEnvironment);
  }
}

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
