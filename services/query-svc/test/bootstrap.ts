import { bootstrap } from "../src/main.js";
import type { NestExpressApplication } from "@nestjs/platform-express";

export async function createTestApp(): Promise<NestExpressApplication> {
  return bootstrap();
}
