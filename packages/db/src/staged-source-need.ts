import {
  RETRY_ELIGIBILITY_WINDOW_MS,
  retryableFailureReasons,
  terminalJobStatuses,
} from "@scvs/core";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * A job that may still read a staged source copy: public and not yet terminal, owing a source publish,
 * or failed in a way the retry scan will revive. Shared by the upload sweep and the rebuild-scoped release
 * so the two can never disagree about who still needs the bytes.
 */
export function stillNeedsStagedSourceWhere(
  ceilingMs: number,
  now: Date,
  maxRetryAttempts: number,
): Prisma.JobWhereInput {
  const cutoff = new Date(now.getTime() - ceilingMs);
  const retryWindowCutoff = new Date(now.getTime() - RETRY_ELIGIBILITY_WINDOW_MS);
  return {
    createdAt: { gt: cutoff },
    OR: [
      { status: { notIn: [...terminalJobStatuses] }, sourceRef: { path: ["visibility"], equals: "public" } },
      { sourcePublishPendingSince: { not: null } },
      {
        status: "failed",
        failureReason: { in: [...retryableFailureReasons] },
        retryAttempts: { lt: maxRetryAttempts },
        updatedAt: { gte: retryWindowCutoff },
      },
    ],
  };
}
