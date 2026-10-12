import type { ThrottlerStorage } from "@nestjs/throttler";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { errorBody } from "./api-error.js";

const THROTTLER_NAME = "adapter-routes";

export function adapterRouteThrottle(options: {
  storage: ThrottlerStorage;
  limit: number;
  ttlMs: number;
  prefixes: readonly string[];
}): RequestHandler {
  const { storage, limit, ttlMs, prefixes } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!prefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
      next();
      return;
    }

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
