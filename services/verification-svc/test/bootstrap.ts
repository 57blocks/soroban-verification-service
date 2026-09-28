import type { NestExpressApplication } from "@nestjs/platform-express";
import { bootstrap } from "../src/main.js";

/** Close it in `afterAll` before deleting rows: closing stops the interval sweeps and waits out the running one. */
export function createTestApp(): Promise<NestExpressApplication> {
  return bootstrap();
}
