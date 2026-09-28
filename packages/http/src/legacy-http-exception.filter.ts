import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { ScvsLogger } from "@scvs/core";
import type { Request, Response } from "express";
import { errorBody, ERROR_SCHEMA, ERROR_SCHEMA_VERSION } from "./api-error.js";

@Catch()
export class LegacyHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new ScvsLogger("http-errors");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && "status_code" in body) {
        // A hand-built `HttpException` body may lack both identifiers; this is the last point to add them.
        response.status(status).json({ schema: ERROR_SCHEMA, schema_version: ERROR_SCHEMA_VERSION, ...body });
        return;
      }
      const message = typeof body === "string" ? body : (body as { message?: unknown })?.message ?? exception.message;
      response.status(status).json(
        errorBody(status, {
          error: status === HttpStatus.NOT_FOUND ? "not_found" : "request_failed",
          message: Array.isArray(message) ? message.join(", ") : String(message),
        }),
      );
      return;
    }

    // `method` and `route`, never the full URL: its path and query are submitter-controlled.
    const request = host.switchToHttp().getRequest<Request>();
    this.logger.error("unhandled error", {
      error: exception instanceof Error ? exception : String(exception),
      method: request?.method,
      route: request?.route?.path ?? "unmatched",
    });
    response.status(500).json(
      errorBody(500, {
        error: "internal_error",
        message: exception instanceof Error ? exception.message : "Internal server error",
      }),
    );
  }
}
