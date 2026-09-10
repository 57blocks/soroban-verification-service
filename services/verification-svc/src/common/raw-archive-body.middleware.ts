import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NextFunction, Request, Response } from "express";
import { errorBody } from "./api-error.exception.js";
import type { AppConfigService } from "../config/configuration.js";

/** Accumulates the raw request body as a Buffer instead of parsing it as JSON — uploads are binary tarballs. */
@Injectable()
export class RawArchiveBodyMiddleware implements NestMiddleware {
  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const maxUploadBytes = this.configService.get("maxSourceArchiveBytes", { infer: true });
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        res.status(413).json(
          errorBody(413, {
            error: "source_archive_too_large",
            message: `Source archive exceeds ${maxUploadBytes} bytes.`,
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      (req as Request & { body: Buffer }).body = Buffer.concat(chunks);
      next();
    });

    req.on("error", next);
  }
}
