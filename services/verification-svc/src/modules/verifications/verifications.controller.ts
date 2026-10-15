import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Inject,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  Sse,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiExcludeEndpoint,
  ApiExtraModels,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { BuildLogUnavailableResponse, JobStatusResponse, UploadSourceResponse } from "./jobs.dto.js";
import { submitAcceptedSchema, submitIncompleteSchema, submitResponseVariants } from "./submit.dto.js";
import type { Request, Response } from "express";
import type { Observable } from "rxjs";
import { AbuseGuard } from "../../common/abuse.guard.js";
import { fingerprintIp } from "../../common/abuse-guard.js";
import { DrainGuard } from "../../common/drain.guard.js";

import { JobsService } from "./jobs.service.js";
import { mapSubmitIssues, SubmitRequestDto } from "./submit.dto.js";
import { SubmitService } from "./submit.service.js";
import { UploadsService } from "./uploads.service.js";
import type { AppConfigService } from "../../config/configuration.js";
import { ApiError, ApiErrorResponse } from "@scvs/http";

@ApiTags("Verifications")
@Controller()
export class VerificationsController {
  constructor(
    @Inject(SubmitService) private readonly submitService: SubmitService,
    @Inject(JobsService) private readonly jobsService: JobsService,
    @Inject(UploadsService) private readonly uploadsService: UploadsService,
    @Inject(ConfigService) private readonly configService: AppConfigService,
  ) {}

  @Post("api/verification/v1/verifications")
  @Header("Cache-Control", "no-store")
  // DrainGuard before AbuseGuard: a submission refused for draining must not consume the submitter's quota.
  @UseGuards(DrainGuard, AbuseGuard)
  @ApiOperation({
    operationId: "submitVerification",
    summary: "Submit a contract for verification",
    description: "Creates a verification job for a deployed contract.\n\nSend a `manifest` naming the source — `source_uri`, or the `upload_id` of an upload — and its `source_sha256`. Without a manifest, the service builds one from the contract's on-chain SEP-58 metadata when it can.\n\nAnswers `202` with the queued job, or `200` with `incomplete` when it could not complete the manifest on its own: add the fields named in `missing_fields`, or send a full manifest. A new job's `202` carries `build_log_token`, the only way to read its build log later; a submission that matches a job already in flight gets that job back without one. With `dry_run: true` the job builds and compares but publishes nothing.",
  })
  @ApiBody({ type: SubmitRequestDto })
  @ApiExtraModels(...submitResponseVariants)
  @ApiOkResponse({ schema: submitIncompleteSchema(), description: "Manifest required — `incomplete`." })
  @ApiAcceptedResponse({ schema: submitAcceptedSchema(), description: "A job exists for this target — `queued`." })
  @ApiBadRequestResponse({ type: ApiErrorResponse, description: "invalid_request, a rejected manifest, a rejected upload reference, or terms_acceptance_required / terms_version_outdated — both distinct from invalid_request." })
  @ApiNotFoundResponse({ type: ApiErrorResponse, description: "The target was not found on the named network." })
  @ApiResponse({ status: 502, type: ApiErrorResponse, description: "The chain could not be read to answer this submission." })
  @ApiServiceUnavailableResponse({ type: ApiErrorResponse, description: "draining" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  @UsePipes(
    new ValidationPipe({
      transform: true,
      exceptionFactory: (errors) => {
        const mapped = mapSubmitIssues(errors);
        return new ApiError(mapped.status_code, mapped);
      },
    }),
  )
  async submit(@Body() body: SubmitRequestDto, @Res() res: Response): Promise<void> {
    const result = await this.submitService.submit(body);
    res.status(result.statusCode).json(result.body);
  }

  @Get("api/verification/v1/verifications/:job_id")
  @Header("Cache-Control", "no-store")
  @SkipThrottle()
  @ApiOperation({
    operationId: "getJob",
    summary: "Get a job's status",
    description: "Returns the job's current state and progress and, once it finishes, its result. Poll this, or follow `GET /verifications/{job_id}/events`, a server-sent event stream that carries the same status on every change.",
  })
  @ApiParam({ name: "job_id", format: "uuid" })
  @ApiOkResponse({ type: JobStatusResponse })
  @ApiNotFoundResponse({ type: ApiErrorResponse, description: "not_found — no such job" })
  @ApiBadRequestResponse({ description: "invalid_job_id" })
  async getJob(
    @Param(
      "job_id",
      new ParseUUIDPipe({
        exceptionFactory: () => new ApiError(400, { error: "invalid_job_id", message: "job_id must be a UUID" }),
      }),
    )
    jobId: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.jobsService.getJob(jobId);
    res.status(result.statusCode).json(result.body);
  }

  @Get("api/verification/v1/verifications/:job_id/log")
  @Header("Cache-Control", "no-store")
  @UseGuards(AbuseGuard)
  @ApiOperation({
    operationId: "getBuildLog",
    summary: "Read a job's build log",
    description: "Returns the redacted build output as plain text. Send the `build_log_token` from the submission in `X-Build-Log-Token`. No token is `401`; a wrong token and an unknown job are both `404`; a log past its retention period is `410`. A job that never ran a build has no log.",
  })
  @ApiHeader({
    name: "x-build-log-token",
    required: true,
    description: "The one-time token returned in this job's submission response.",
  })
  @ApiUnauthorizedResponse({ type: ApiErrorResponse, description: "build_log_token_required" })
  @ApiResponse({ status: 410, type: ApiErrorResponse, description: "build_log_expired" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  @ApiParam({ name: "job_id", format: "uuid" })
  // Declared content type: without a schema the generated client types this body `void`.
  @ApiOkResponse({ description: "Redacted build output.", content: { "text/plain": { schema: { type: "string" } } } })
  @ApiNotFoundResponse({ type: BuildLogUnavailableResponse })
  @ApiBadRequestResponse({ description: "invalid_job_id" })
  async getBuildLog(
    @Param(
      "job_id",
      new ParseUUIDPipe({
        exceptionFactory: () => new ApiError(400, { error: "invalid_job_id", message: "job_id must be a UUID" }),
      }),
    )
    jobId: string,
    @Headers("x-build-log-token") buildLogToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.jobsService.getBuildLog(jobId, buildLogToken);
    if (typeof result.body === "string") {
      res.status(result.statusCode).type("text/plain").send(result.body);
      return;
    }
    res.status(result.statusCode).json(result.body);
  }

  @Delete("api/verification/v1/verifications/:job_id/log")
  @Header("Cache-Control", "no-store")
  @UseGuards(AbuseGuard)
  @ApiOperation({
    operationId: "deleteBuildLog",
    summary: "Delete a job's build log",
    description: "Ends the log's access window at once, so a later read of a recorded log is `410`. Takes the same token as reading it, and succeeds on a log that is already gone.",
  })
  @ApiHeader({
    name: "x-build-log-token",
    required: true,
    description: "The one-time token returned in this job's submission response.",
  })
  @ApiParam({ name: "job_id", format: "uuid" })
  @ApiNoContentResponse({ description: "The raw log is gone. Idempotent — deleting an absent log succeeds." })
  @ApiUnauthorizedResponse({ type: ApiErrorResponse, description: "build_log_token_required" })
  @ApiNotFoundResponse({ type: ApiErrorResponse, description: "not_found — including a token that does not match" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  async deleteBuildLog(
    @Param(
      "job_id",
      new ParseUUIDPipe({
        exceptionFactory: () => new ApiError(400, { error: "invalid_job_id", message: "job_id must be a UUID" }),
      }),
    )
    jobId: string,
    @Headers("x-build-log-token") buildLogToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.jobsService.deleteBuildLog(jobId, buildLogToken);
    if (result.statusCode === 204) {
      res.status(204).send();
      return;
    }
    res.status(result.statusCode).json(result.body);
  }

  @Sse("api/verification/v1/verifications/:job_id/events")
  @Header("Cache-Control", "no-store")
  // Exempt from the request-rate throttler (an open stream is not a request); opening one is metered by AbuseGuard.
  @SkipThrottle()
  @UseGuards(AbuseGuard)
  @ApiExcludeEndpoint()
  @ApiParam({ name: "job_id", format: "uuid" })
  @ApiOkResponse({ type: JobStatusResponse, description: "One event per status change, `text/event-stream`." })
  @ApiBadRequestResponse({ description: "invalid_job_id" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  jobEvents(
    @Param(
      "job_id",
      new ParseUUIDPipe({
        exceptionFactory: () => new ApiError(400, { error: "invalid_job_id", message: "job_id must be a UUID" }),
      }),
    )
    jobId: string,
    @Req() req: Request,
  ): Observable<MessageEvent> {
    const ipFingerprint = fingerprintIp(req, this.configService.get("abuseFingerprintKey", { infer: true }));
    return this.jobsService.streamJob(jobId, ipFingerprint);
  }

  @Post("api/verification/v1/uploads/source")
  @Header("Cache-Control", "no-store")
  // No DrainGuard/AbuseGuard: RawArchiveBodyMiddleware runs both before the body is buffered.
  // `process.env`, not ConfigService: a decorator argument is evaluated at module load, before DI exists.
  @Throttle({ default: { limit: Number(process.env.SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE || 60), ttl: 60_000 } })
  @ApiOperation({
    operationId: "uploadSource",
    summary: "Upload a source archive",
    description: "Accepts the raw bytes of a gzip tarball or a zip file and returns an `upload_id` and the archive's `source_sha256`, both for a submission's manifest. The format is read from the bytes, not from the filename. An upload expires 30 minutes after it is received; its `expires_at` says when.",
  })
  @ApiConsumes("application/gzip")
  @ApiHeader({ name: "x-filename", required: false, description: "Original filename of the uploaded archive." })
  @ApiBody({ schema: { type: "string", format: "binary" } })
  @ApiOkResponse({ type: UploadSourceResponse })
  @ApiBadRequestResponse({ type: ApiErrorResponse, description: "invalid_upload, or source_archive_format_unsupported — a gzip tarball (.tar.gz/.tgz/.gz) or a zip (.zip) is accepted." })
  @ApiResponse({ status: 413, type: ApiErrorResponse, description: "source_archive_too_large." })
  @ApiServiceUnavailableResponse({ type: ApiErrorResponse, description: "draining" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  async uploadSource(@Req() req: Request, @Headers("x-filename") filename: string | undefined, @Res() res: Response): Promise<void> {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await this.uploadsService.receive(body, filename);
    res.status(result.statusCode).json(result.body);
  }
}
