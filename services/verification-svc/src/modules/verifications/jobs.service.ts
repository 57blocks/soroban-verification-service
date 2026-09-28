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

import type { ApiResponse } from "./submit.service.js";
import type { AppConfigService } from "../../config/configuration.js";
import { errorBody } from "@scvs/http";

const BUILD_LOG_KEY_PREFIX = "build-logs/";

function isBuildLogKey(key: string): boolean {
  return key.startsWith(BUILD_LOG_KEY_PREFIX) && !key.includes("..");
}

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

type BuildLogAvailability = {
  state: "none" | "available" | "expired";
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

export class StreamConcurrencyLimiter {
  private readonly perJob = new Map<string, number>();
  private readonly perIp = new Map<string, number>();
  private total = 0;

  tryAcquire(
    jobId: string,
    ipFingerprint: string | null,
    maxPerJob: number,
    maxPerIp: number,
    maxTotal: number,
  ): boolean {
    if (this.total >= maxTotal) return false;
    if ((this.perJob.get(jobId) ?? 0) >= maxPerJob) return false;
    if (ipFingerprint !== null && (this.perIp.get(ipFingerprint) ?? 0) >= maxPerIp) return false;
    this.perJob.set(jobId, (this.perJob.get(jobId) ?? 0) + 1);
    if (ipFingerprint !== null) {
      this.perIp.set(ipFingerprint, (this.perIp.get(ipFingerprint) ?? 0) + 1);
    }
    this.total += 1;
    return true;
  }

  release(jobId: string, ipFingerprint: string | null): void {
    const currentPerJob = this.perJob.get(jobId);
    if (currentPerJob === undefined) return;
    if (currentPerJob <= 1) {
      this.perJob.delete(jobId);
    } else {
      this.perJob.set(jobId, currentPerJob - 1);
    }
    if (ipFingerprint !== null) {
      const currentPerIp = this.perIp.get(ipFingerprint) ?? 0;
      if (currentPerIp <= 1) {
        this.perIp.delete(ipFingerprint);
      } else {
        this.perIp.set(ipFingerprint, currentPerIp - 1);
      }
    }
    this.total = Math.max(0, this.total - 1);
  }
}

@Injectable()
export class JobsService {
  private readonly logger = new ScvsLogger("job-status");
  private readonly streamLimiter = new StreamConcurrencyLimiter();

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(JobEventsService) private readonly jobEvents: JobEventsService,
  ) {}

  /** A wrong token answers the same 404 as a nonexistent job, so the route is no oracle for which ids are real. */
  async getBuildLog(jobId: string, suppliedToken?: string): Promise<ApiResponse> {
    const job = await this.jobs.getJobById(jobId);
    // Checked before a missing row is reported, so "no token" looks the same for real and invented jobs.
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

    if (job.buildLogExpiresAt && job.buildLogExpiresAt.getTime() <= Date.now()) {
      return { statusCode: 410, body: errorBody(410, expiredBody(job.buildLogExpiresAt)) };
    }

    if (!job.buildLogObjectKey) {
      return {
        statusCode: 404,
        body: errorBody(404, {
          error: "not_found",
          message: "No build log was recorded for this job.",
      job_status: toWireVerificationStatus(job.status, job.failureReason, job.verdict),
          ...(job.failureReason ? { failure_reason: job.failureReason } : {}),
        }),
      };
    }

    // The key is written from the sandbox side, and the staging bucket also holds private source tarballs.
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

    this.logger.log("raw build log served", { job_id: jobId, object_key: job.buildLogObjectKey });

    return { statusCode: 200, body: sanitizeTerminalOutput(log) };
  }

  /** One rebuild's log serves several jobs, so the bytes go only when no sibling still holds a live claim. */
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

  streamJob(jobId: string, ipFingerprint: string | null): Observable<MessageEvent> {
    const safetyPollMs = this.configService.get("jobStreamSafetyPollMs", { infer: true });
    const streamWindowMs = this.configService.get("jobStreamWindowMs", { infer: true });
    const maxWaitMs = this.configService.get("jobMaxWaitMs", { infer: true });
    const maxConnectionsPerJob = this.configService.get("jobStreamMaxConnectionsPerJob", { infer: true });
    const maxConnectionsPerIp = this.configService.get("jobStreamMaxConnectionsPerIp", { infer: true });
    const maxConnectionsTotal = this.configService.get("jobStreamMaxConnectionsTotal", { infer: true });

    return new Observable<MessageEvent>((subscriber) => {
      // Before any setup: a rejected connection must never register a listener, an interval or a timeout.
      if (!this.streamLimiter.tryAcquire(jobId, ipFingerprint, maxConnectionsPerJob, maxConnectionsPerIp, maxConnectionsTotal)) {
        this.logger.warn("stream connection rejected: concurrency ceiling reached", {
          job_id: jobId,
          max_connections_per_job: maxConnectionsPerJob,
          max_connections_per_ip: maxConnectionsPerIp,
          max_connections_total: maxConnectionsTotal,
        });
        subscriber.next({
          data: errorBody(429, {
            error: "stream_connection_limit_reached",
            message: "Too many open connections for this job. Reconnect after closing an existing stream.",
          }),
        });
        subscriber.complete();
        return () => {};
      }

      let closed = false;
      let unsubscribeNotify: (() => void) | undefined;
      let safetyInterval: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let released = false;
      let lastBody: JobStatusBody | undefined;

      const cleanup = () => {
        closed = true;
        unsubscribeNotify?.();
        if (safetyInterval) clearInterval(safetyInterval);
        if (timeout) clearTimeout(timeout);
        if (!released) {
          released = true;
          this.streamLimiter.release(jobId, ipFingerprint);
        }
      };

      const emitCurrent = async (): Promise<boolean> => {
        if (closed) return true;
        const body = await this.loadJobBody(jobId);
        if (!body) {
          subscriber.next({ data: errorBody(404, { error: "not_found", message: `Job ${jobId} not found` }) });
          subscriber.complete();
          cleanup();
          return true;
        }
        lastBody = body;
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

      const onWindowExpired = async (): Promise<void> => {
        if (closed) return;
        const body = await this.loadJobBody(jobId);
        if (!body || TERMINAL_STATUSES.has(body.status)) {
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

      // Ends the response the way an elapsed window does, so the client reconnects instead of seeing an error.
      const onReadFailed = (error: unknown) => {
        if (closed) return;
        this.logger.error("stream read failed, ending the response for the client to reconnect", {
          job_id: jobId,
          error: error instanceof Error ? error : String(error),
        });
        // Until a first body is out, the setup read owns the stream and settles it either way.
        if (!lastBody) return;
        subscriber.next({ data: { ...lastBody, stream_timeout: true } });
        subscriber.complete();
        cleanup();
      };

      void (async () => {
        // Subscribe to NOTIFY before the first fetch, or a change landing between the two is missed.
        const unsubscribe = await this.jobEvents.subscribeToJobUpdates((notifiedJobId) => {
          if (notifiedJobId === jobId) void emitCurrent().catch(onReadFailed);
        });
        if (closed) {
          unsubscribe();
          return;
        }
        unsubscribeNotify = unsubscribe;

        const done = await emitCurrent();
        // The client can disconnect during the first read, after cleanup() had nothing to clear.
        if (done || closed) return;

        this.logger.log("stream open, waiting for status changes", { job_id: jobId });
        safetyInterval = setInterval(() => void emitCurrent().catch(onReadFailed), safetyPollMs);
        timeout = setTimeout(() => void onWindowExpired().catch(onReadFailed), streamWindowMs);
      })().catch((error) => {
        if (closed) return;
        this.logger.error("stream setup failed", { job_id: jobId, error: error instanceof Error ? error : String(error) });
        subscriber.next({
          data: errorBody(500, { error: "internal_error", message: "The verification stream could not be started." }),
        });
        subscriber.complete();
        cleanup();
      });

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
