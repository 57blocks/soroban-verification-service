import { Inject, Injectable, type MessageEvent } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobEventsService, JobsRepository } from "@scvs/db";
import {
  buildLogTokenMatches,
  isBuildLogTokenShaped,
  sanitizeTerminalOutput,
  ScvsLogger,
  toWireVerificationStatus,
  verificationStatuses,
  type VerificationStatus,
} from "@scvs/core";
import { createS3Client, deleteObject, getObjectText } from "@scvs/aws";
import { getStagingStorageConfig } from "@scvs/config";
import { Observable } from "rxjs";
import { errorBody } from "../../common/api-error.exception.js";
import type { ApiResponse } from "./submit.service.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Where a job's build log may live. Anything else is not this route's to serve. */
const BUILD_LOG_KEY_PREFIX = "build-logs/";

function isBuildLogKey(key: string): boolean {
  return key.startsWith(BUILD_LOG_KEY_PREFIX) && !key.includes("..");
}

/** Same shape whether the sweep has run yet or not — an expired log and a deleted one are one state. */
function expiredBody(expiredAt: Date) {
  return {
    error: "build_log_expired" as const,
    message: "This job's raw build log has expired and been deleted. The diagnostic summary remains.",
    expired_at: expiredAt.toISOString(),
  };
}

const TERMINAL_STATUSES = new Set<VerificationStatus>(
  verificationStatuses.filter((status) => status !== "queued" && status !== "running"),
);

type JobStatusBody = {
  job_id: string;
  status: VerificationStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  target: unknown;
  result: unknown;
  error: string | undefined;
  progress: unknown;
  build_log: BuildLogAvailability;
};

/**
 * The minimized layer (build-log-access design.md BL-6): enough for a caller to tell "there is no log" from
 * "there is a log you may not read" without either being an oracle, and **carrying no captured output**.
 */
type BuildLogAvailability = {
  state: "none" | "available" | "expired";
  /** Always true where a log exists: the job id does not authorise a raw log. */
  requires_token: boolean;
  expires_at?: string;
};

function buildLogAvailability(job: {
  buildLogObjectKey?: string;
  buildLogExpiresAt?: Date;
}): BuildLogAvailability {
  const expired = Boolean(job.buildLogExpiresAt && job.buildLogExpiresAt.getTime() <= Date.now());
  if (!job.buildLogObjectKey || expired) {
    return { state: expired ? "expired" : "none", requires_token: false };
  }
  return {
    state: "available",
    requires_token: true,
    ...(job.buildLogExpiresAt ? { expires_at: job.buildLogExpiresAt.toISOString() } : {}),
  };
}

@Injectable()
export class JobsService {
  private readonly logger = new ScvsLogger("job-status");

  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(JobEventsService) private readonly jobEvents: JobEventsService,
  ) {}

  /**
   * The job's own raw build output, behind its token (build-log-access design.md BL-1).
   *
   * The response ladder is part of the requirement, not an implementation detail: a wrong token answers the
   * same 404 as a job that does not exist, so the route is not an oracle for which job ids are real.
   */
  async getBuildLog(jobId: string, suppliedToken?: string): Promise<ApiResponse> {
    const job = await this.jobs.getJobById(jobId);
    // Checked before the row is even reported missing, so "no token" is indistinguishable between a real job
    // and an invented one.
    if (!suppliedToken) {
      return {
        statusCode: 401,
        body: errorBody(401, {
          error: "build_log_token_required",
          message:
            "The raw build log needs the X-Build-Log-Token returned once when this job was submitted.",
        }),
      };
    }
    if (!job || !isBuildLogTokenShaped(suppliedToken) || !buildLogTokenMatches(suppliedToken, job.buildLogTokenHash)) {
      return { statusCode: 404, body: errorBody(404, { error: "not_found", message: `Job ${jobId} not found` }) };
    }

    // Enforced on READ, not only by the sweep: a sweep that is late, wedged or not yet deployed must not
    // silently extend the promise the Privacy Notice makes (design.md BL-2).
    if (job.buildLogExpiresAt && job.buildLogExpiresAt.getTime() <= Date.now()) {
      return { statusCode: 410, body: errorBody(410, expiredBody(job.buildLogExpiresAt)) };
    }

    if (!job.buildLogObjectKey) {
      return {
        statusCode: 404,
        body: errorBody(404, {
          error: "not_found",
          message: "No build log was recorded for this job.",
          // The *external* status, never the internal `JobStatus`. `submit.service.ts` documents what
      // leaking one costs: a value the OpenAPI document says cannot occur, so the generated client's type is a
      // lie and a consumer's exhaustive branching falls through every arm.
      job_status: toWireVerificationStatus(job.status, job.failureReason, job.verdict),
          ...(job.failureReason ? { failure_reason: job.failureReason } : {}),
        }),
      };
    }

    // The key's eventual writer is the sandbox side of the trust boundary, and the staging bucket also holds
    // submitters' private source tarballs.
    if (!isBuildLogKey(job.buildLogObjectKey)) {
      this.logger.error("build log key outside the build-log prefix, refusing to read it", {
        job_id: jobId,
        object_key: job.buildLogObjectKey,
      });
      return {
        statusCode: 502,
        body: errorBody(502, {
          error: "build_log_unavailable",
          message: "This job's build log reference is not readable.",
        }),
      };
    }

    // `SCVS_STORAGE_BUCKET` is deliberately optional for this service (env.dto.ts: it must still serve
    // preflight, submit and every job-status route without one), and `getStagingStorageConfig` throws when it
    // is unset.
    let staging: ReturnType<typeof getStagingStorageConfig>;
    try {
      staging = getStagingStorageConfig();
    } catch (error) {
      this.logger.error("build log requested but no staging bucket is configured", {
        job_id: jobId,
        error: error instanceof Error ? error : String(error),
      });
      return {
        statusCode: 502,
        body: errorBody(502, {
          error: "build_log_unavailable",
          message: "This job recorded a build log, but it could not be read back.",
        }),
      };
    }

    const log = await getObjectText(createS3Client({ region: staging.region }), staging.bucket, job.buildLogObjectKey);
    if (log === undefined) {
      // The row points at an object that is not there — a real fault, not "no log yet", so it must not be
      // reported as the same 404 as a job that never produced one.
      this.logger.error("build log object missing for a job that records one", {
        job_id: jobId,
        object_key: job.buildLogObjectKey,
      });
      return {
        statusCode: 502,
        body: errorBody(502, {
          error: "build_log_unavailable",
          message: "This job recorded a build log, but it could not be read back.",
        }),
      };
    }

    // One record per successful raw read (design.md BL-5). Nothing token-derived is in it: a fingerprint of
    // the token would be a second thing to protect for no gain, since the job id already identifies the read.
    this.logger.log("raw build log served", { job_id: jobId, object_key: job.buildLogObjectKey });

    // The log is whatever a submitter's source made the compiler print, so control sequences are stripped
    // here rather than in the console — `curl` and every SDK consumer get the same bytes (design.md BL-4).
    return { statusCode: 200, body: sanitizeTerminalOutput(log) };
  }

  /**
   * Early deletion by the token holder (design.md BL-3). Idempotent, and subject to the same sharing rule the
   * sweep obeys: one rebuild's log serves several jobs, so the bytes go only when no sibling still holds a
   * live claim on them.
   */
  async deleteBuildLog(jobId: string, suppliedToken?: string): Promise<ApiResponse> {
    const job = await this.jobs.getJobById(jobId);
    if (!suppliedToken) {
      return {
        statusCode: 401,
        body: errorBody(401, {
          error: "build_log_token_required",
          message: "Deleting the raw build log needs the X-Build-Log-Token for this job.",
        }),
      };
    }
    if (!job || !isBuildLogTokenShaped(suppliedToken) || !buildLogTokenMatches(suppliedToken, job.buildLogTokenHash)) {
      return { statusCode: 404, body: errorBody(404, { error: "not_found", message: `Job ${jobId} not found` }) };
    }
    // Nothing to delete is a success: the caller asked for the log to be gone and it is.
    if (!job.buildLogObjectKey) return { statusCode: 204, body: "" };

    const objectKey = job.buildLogObjectKey;
    // This job stops claiming the object first, so a concurrent sibling read cannot re-establish the claim.
    await this.jobs.expireBuildLogForJob(jobId);

    const stillClaimed = await this.jobs.countLiveBuildLogClaims(objectKey, new Date());
    if (stillClaimed === 0) {
      try {
        const staging = getStagingStorageConfig();
        await deleteObject(createS3Client({ region: staging.region }), staging.bucket, objectKey);
        await this.jobs.clearBuildLogKey(objectKey);
      } catch (error) {
        // The row is already expired, so the log is unreadable either way; the sweep retries the bytes.
        this.logger.error("build log delete failed; the object is left to the expiry sweep", {
          job_id: jobId,
          object_key: objectKey,
          error: error instanceof Error ? error : String(error),
        });
      }
    }
    this.logger.log("raw build log deleted by its token holder", { job_id: jobId, shared: stillClaimed > 0 });
    return { statusCode: 204, body: "" };
  }

  async getJob(jobId: string): Promise<ApiResponse> {
    const body = await this.loadJobBody(jobId);
    if (!body) {
      return {
        statusCode: 404,
        body: errorBody(404, { error: "not_found", message: `Job ${jobId} not found` }),
      };
    }
    return { statusCode: 200, body };
  }

  /** Real push, not a poll: subscribes to `@scvs/db`'s `subscribeToJobUpdates`. */
  streamJob(jobId: string): Observable<MessageEvent> {
    const safetyPollMs = this.configService.get("jobStreamSafetyPollMs", { infer: true });
    const streamWindowMs = this.configService.get("jobStreamWindowMs", { infer: true });
    const maxWaitMs = this.configService.get("jobMaxWaitMs", { infer: true });

    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let unsubscribeNotify: (() => void) | undefined;
      let safetyInterval: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        closed = true;
        unsubscribeNotify?.();
        if (safetyInterval) clearInterval(safetyInterval);
        if (timeout) clearTimeout(timeout);
      };

      // Returns true once the stream has reached a terminal state (or the job vanished) and has already
      // completed the subscriber — callers stop scheduling further checks.
      const emitCurrent = async (): Promise<boolean> => {
        if (closed) return true;
        const body = await this.loadJobBody(jobId);
        if (!body) {
          subscriber.next({ data: errorBody(404, { error: "not_found", message: `Job ${jobId} not found` }) });
          subscriber.complete();
          cleanup();
          return true;
        }
        subscriber.next({ data: body });
        if (TERMINAL_STATUSES.has(body.status)) {
          this.logger.log("stream closing on terminal status", {
            job_id: jobId,
            job_status: body.status,
          });
          subscriber.complete();
          cleanup();
          return true;
        }
        return false;
      };

      // The connection window elapsed. Whether that's news about the *job* depends on how old the job is, which
      // is why this re-reads it rather than failing the stream outright.
      const onWindowExpired = async (): Promise<void> => {
        if (closed) return;
        const body = await this.loadJobBody(jobId);
        if (!body || TERMINAL_STATUSES.has(body.status)) {
          // Terminal (or gone) after all — let the normal path emit it and close.
          await emitCurrent();
          return;
        }

        const ageMs = Date.now() - Date.parse(body.created_at);
        if (ageMs < maxWaitMs) {
          this.logger.log("connection window elapsed, ending response for the client to reconnect", {
            job_id: jobId,
            job_status: body.status,
            job_age_seconds: Math.round(ageMs / 1000),
          });
          subscriber.next({ data: { ...body, stream_timeout: true } });
          subscriber.complete();
          cleanup();
          return;
        }

        this.logger.warn("reporting job_timeout past SCVS_JOB_MAX_WAIT_MS", {
          job_id: jobId,
          job_status: body.status,
          job_age_minutes: Math.round(ageMs / 60_000),
        });
        subscriber.next({
          data: {
            status: "error",
            reason: "job_timeout",
            detail: `The verification job has been "${body.status}" for over ${Math.round(maxWaitMs / 60_000)} minutes.`,
            job_id: jobId,
          },
        });
        subscriber.complete();
        cleanup();
      };

      void (async () => {
        // Subscribe to NOTIFY *before* the first fetch: a status change landing between "we checked" and "we
        // started listening" would otherwise be silently missed.
        const unsubscribe = await this.jobEvents.subscribeToJobUpdates((notifiedJobId) => {
          if (notifiedJobId === jobId) void emitCurrent();
        });
        if (closed) {
          unsubscribe();
          return;
        }
        unsubscribeNotify = unsubscribe;

        const done = await emitCurrent();
        if (done) return;

        this.logger.log("stream open, waiting for status changes", { job_id: jobId });
        safetyInterval = setInterval(() => void emitCurrent(), safetyPollMs);
        timeout = setTimeout(() => void onWindowExpired(), streamWindowMs);
      })();

      return cleanup;
    });
  }

  private async loadJobBody(jobId: string): Promise<JobStatusBody | undefined> {
    const job = await this.jobs.getJobById(jobId);
    if (!job) return undefined;
    return {
      job_id: job.jobId,
      status: toWireVerificationStatus(job.status, job.failureReason, job.verdict),
      created_at: job.createdAt,
      // `updated_at` is the row's last change, not a finish time; `completed_at` is the finish time.
      updated_at: job.updatedAt,
      ...(job.completedAt ? { completed_at: job.completedAt } : {}),
      target: job.target,
      result: job.result,
      error: job.error,
      progress: job.progress,
      build_log: buildLogAvailability(job),
    };
  }
}
