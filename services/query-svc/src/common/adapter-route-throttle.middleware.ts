import type { ThrottlerStorage } from "@nestjs/throttler";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { errorBody } from "./api-error.exception.js";

/**
 * The quota for routes Nest's guard chain cannot reach.
 *
 * `SwaggerModule.setup()` registers its document and its UI straight on the HTTP adapter, so no route-level
 * guard is ever consulted for them — `APP_GUARD` does not see them and `@SkipThrottle()` has nothing to act
 * on. Left alone they are an unauthenticated public entry with no ceiling at all: cheap to ask for, and the
 * document is not small. This is express middleware because that is the only layer both it and Swagger share.
 *
 * It counts through the SAME storage the guard uses, under its own throttler name, so the documentation
 * surface gets its own budget rather than spending a reader's API quota.
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
