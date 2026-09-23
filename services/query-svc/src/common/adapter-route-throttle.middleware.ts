import type { ThrottlerStorage } from "@nestjs/throttler";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { errorBody } from "@scvs/http";

/**
 * The quota for routes Nest's guard chain cannot reach. `SwaggerModule.setup()` registers on the HTTP adapter,
 * where no route-level guard is consulted, so middleware is the only layer both it and Swagger share. Counts
 * through the guard's own storage under a separate name, so the document has its own budget.
 */
const THROTTLER_NAME = "adapter-routes";

export function adapterRouteThrottle(options: {
  storage: ThrottlerStorage;
  limit: number;
  ttlMs: number;
  /** Matched against the request path by prefix — Swagger serves its UI assets beneath its own mount point. */
  prefixes: readonly string[];
}): RequestHandler {
  const { storage, limit, ttlMs, prefixes } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!prefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
      next();
      return;
    }

    // `req.ip` and not the socket address, for the same reason the guard keys on it: `trust proxy` is what
    // makes this the caller rather than the balancer node.
    const caller = req.ip || req.socket.remoteAddress || "unknown";

    void storage
      .increment(`${THROTTLER_NAME}:${caller}`, ttlMs, limit, ttlMs, THROTTLER_NAME)
      .then((record) => {
        if (record.totalHits <= limit && !record.isBlocked) {
          next();
          return;
        }
        res
          .status(429)
          .json(
            errorBody(429, { error: "rate_limited", message: "Too many requests, please try again later." }),
          );
      })
      .catch(next);
  };
}

export { THROTTLER_NAME as ADAPTER_ROUTE_THROTTLER_NAME };
