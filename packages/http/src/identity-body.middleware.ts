import type { NextFunction, Request, RequestHandler, Response } from "express";
import { errorBody } from "./api-error.js";

/** Runs before every body parser: a decoded body would reach Node's decompressors with bytes the caller chose. */
export function refuseEncodedRequestBodies(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const encoding = req.headers["content-encoding"]?.trim().toLowerCase();
    if (!encoding || encoding === "identity") {
      next();
      return;
    }
    res.setHeader("Connection", "close");
    res.status(415).json(
      errorBody(415, {
        error: "content_encoding_unsupported",
        message: "Request bodies are accepted only without a Content-Encoding. Send the body uncompressed.",
      }),
    );
  };
}

/** The body parsers both public services register, with request decompression switched off. */
export const IDENTITY_BODY_PARSERS = [
  ["json", { inflate: false }],
  ["urlencoded", { inflate: false, extended: true }],
] as const;
