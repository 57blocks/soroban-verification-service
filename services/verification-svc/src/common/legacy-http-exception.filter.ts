import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { ScvsLogger } from "@scvs/core";
import type { Request, Response } from "express";
import { ERROR_SCHEMA, ERROR_SCHEMA_VERSION, errorBody } from "./api-error.exception.js";

/**
 * Global fallback so every response — including ones Nest itself generates (an unmatched route, a guard
 * rejection, an uncaught error) — comes back in the one error shape.
 */
@Catch()
export class LegacyHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new ScvsLogger("http-errors");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && "status_code" in body) {
        // A hand-built `HttpException` carrying `status_code` but no envelope identifiers still has to come out
        // with both — this is the last point at which any of them can be given them.
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

    // `method` and `route`, never the full URL: a query string or path segment is submitter-controlled text and
    // this is the catch-all every unhandled error reaches.
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
