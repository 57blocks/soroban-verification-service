import { Injectable, type NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { runWithLogContext } from "@scvs/core";
import type { NextFunction, Request, Response } from "express";

/** Lowercase because Node normalises header names. */
export const REQUEST_ID_HEADER = "x-request-id";

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = sanitizeRequestId(request.header(REQUEST_ID_HEADER)) ?? randomUUID();
    response.setHeader(REQUEST_ID_HEADER, requestId);
    runWithLogContext({ request_id: requestId }, () => next());
  }
}

export function sanitizeRequestId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /^[A-Za-z0-9._-]{1,128}$/.test(raw) ? raw : undefined;
}
