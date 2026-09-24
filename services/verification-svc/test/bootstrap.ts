import type { NestExpressApplication } from "@nestjs/platform-express";
import { bootstrap } from "../src/main.js";

/**
 * Boots the real Nest `AppModule` (same one main.ts uses in production) without binding a port. A suite closes it
 * in `afterAll`, before deleting its rows: closing stops the interval sweeps and waits out the one running.
 */
export function createTestApp(): Promise<NestExpressApplication> {
  return bootstrap();
}
