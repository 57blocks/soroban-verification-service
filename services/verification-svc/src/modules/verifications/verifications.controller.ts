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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { BuildLogUnavailableResponse, JobStatusResponse, UploadSourceResponse } from "./jobs.dto.js";
import { submitAcceptedSchema, submitIncompleteSchema, submitResponseVariants } from "./submit.dto.js";
import type { Request, Response } from "express";
import type { Observable } from "rxjs";
import { AbuseGuard } from "../../common/abuse.guard.js";
import { DrainGuard } from "../../common/drain.guard.js";
import { ApiError } from "../../common/api-error.exception.js";
import { ApiErrorResponse } from "../../common/api-error.dto.js";
import { JobsService } from "./jobs.service.js";
import { mapSubmitIssues, SubmitRequestDto } from "./submit.dto.js";
import { SubmitService } from "./submit.service.js";
import { UploadsService } from "./uploads.service.js";

@Controller()
export class VerificationsController {
  // Explicit `@Inject()` on every parameter — see preflight.controller.ts's comment.
  constructor(
    @Inject(SubmitService) private readonly submitService: SubmitService,
    @Inject(JobsService) private readonly jobsService: JobsService,
    @Inject(UploadsService) private readonly uploadsService: UploadsService,
  ) {}

  @Post("api/verification/v1/verifications")
  // Job content, so no intermediary may hold it (retention-and-pseudonymisation design.md RP-5).
  @Header("Cache-Control", "no-store")
  // DrainGuard before AbuseGuard: refusing a submission we are about to stop serving should not consume the
  // submitter's quota.
  @UseGuards(DrainGuard, AbuseGuard)
  @ApiOperation({ operationId: "submitVerification" })
  @ApiBody({ type: SubmitRequestDto })
  @ApiExtraModels(...submitResponseVariants)
  // One shape per status code, because that is how they are sent.
  @ApiOkResponse({ schema: submitIncompleteSchema(), description: "Manifest required — `incomplete`." })
  @ApiAcceptedResponse({ schema: submitAcceptedSchema(), description: "A job exists for this target — `queued`." })
  @ApiBadRequestResponse({ type: ApiErrorResponse, description: "invalid_request, a rejected manifest, a rejected upload reference, or terms_acceptance_required / terms_version_outdated — both distinct from invalid_request (TRD §8.1)." })
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
  @ApiOperation({ operationId: "getJob" })
  @ApiParam({ name: "job_id", format: "uuid" })
  @ApiOkResponse({ type: JobStatusResponse })
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
  // The exemption is gone: this route now authenticates, and an unauthenticated caller guessing
  // tokens against it must be metered like any other write-shaped attempt (build-log-access design.md BL-5).
  @UseGuards(AbuseGuard)
  @ApiOperation({ operationId: "getBuildLog" })
  @ApiHeader({
    name: "x-build-log-token",
    required: true,
    description: "The one-time token returned in this job's submission response.",
  })
  @ApiUnauthorizedResponse({ type: ApiErrorResponse, description: "build_log_token_required" })
  @ApiResponse({ status: 410, type: ApiErrorResponse, description: "build_log_expired" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  @ApiParam({ name: "job_id", format: "uuid" })
  // The content type is declared rather than described: without a schema the generated client types this
  // operation's body `void`, and the 404.
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
  @ApiOperation({ operationId: "deleteBuildLog" })
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
  // The fixed-window throttler counts requests, and waiting on an already-open stream is not a request, so
  // @SkipThrottle applies. Opening a stream is a different action: it holds a socket/listener for the
  // connection's life, so it is metered by AbuseGuard on its own (looser) tier — JobsService.streamJob's
  // StreamConcurrencyLimiter bounds how many stay open at once; this bounds how fast new ones may be opened.
  @SkipThrottle()
  @UseGuards(AbuseGuard)
  // Streaming (`text/event-stream`) endpoint, not a normal request/response route.
  @ApiExcludeEndpoint()
  @ApiParam({ name: "job_id", format: "uuid" })
  @ApiOkResponse({ type: JobStatusResponse, description: "One event per status change, `text/event-stream`." })
  @ApiBadRequestResponse({ description: "invalid_job_id" })
  // A real 429 from AbuseGuard, thrown before the SSE response starts. The separate concurrency-ceiling
  // rejection (JobsService.streamJob's StreamConcurrencyLimiter) is a different path: the connection has
  // already opened at 200 by then, so that one answers in-band as an SSE `data` event carrying
  // `stream_connection_limit_reached`, not as an HTTP status code.
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  jobEvents(
    @Param(
      "job_id",
      new ParseUUIDPipe({
        exceptionFactory: () => new ApiError(400, { error: "invalid_job_id", message: "job_id must be a UUID" }),
      }),
    )
    jobId: string,
  ): Observable<MessageEvent> {
    return this.jobsService.streamJob(jobId);
  }

  @Post("api/verification/v1/uploads/source")
  @Header("Cache-Control", "no-store")
  // Neither DrainGuard nor AbuseGuard is applied here: RawArchiveBodyMiddleware runs both checks — drain
  // first, then abuse — before the body is buffered rather than after.
  // Reads `process.env` directly rather than through `ConfigService`: `@Throttle(...)` is a decorator argument,
  // evaluated at class-definition time (module load), before Nest's DI container exists.
  @Throttle({ default: { limit: Number(process.env.SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE || 60), ttl: 60_000 } })
  @ApiOperation({ operationId: "uploadSource" })
  @ApiConsumes("application/gzip")
  @ApiHeader({ name: "x-filename", required: false, description: "Original filename of the uploaded archive." })
  @ApiBody({ schema: { type: "string", format: "binary" } })
  @ApiOkResponse({ type: UploadSourceResponse })
  // Both were already sent and neither was described: the format gate reads the archive's magic number off the
  // body (uploads.service.ts), and the ceiling refuses mid-upload (raw-archive-body.middleware.ts).
  @ApiBadRequestResponse({ type: ApiErrorResponse, description: "invalid_upload, or source_archive_format_unsupported — a gzip tarball (.tar.gz/.tgz) or a zip (.zip) is accepted." })
  @ApiResponse({ status: 413, type: ApiErrorResponse, description: "source_archive_too_large." })
  @ApiServiceUnavailableResponse({ type: ApiErrorResponse, description: "draining" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  async uploadSource(@Req() req: Request, @Headers("x-filename") filename: string | undefined, @Res() res: Response): Promise<void> {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await this.uploadsService.receive(body, filename);
    res.status(result.statusCode).json(result.body);
  }
}
