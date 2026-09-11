import type { Server } from "node:http";
import { bootstrap } from "../src/main.js";

/**
 * Boots the real Nest `AppModule` (same one main.ts uses in production) without binding a port, and hands back
 * the underlying HTTP server for supertest.
 */
export async function createTestServer(): Promise<Server> {
  const app = await bootstrap();
  return app.getHttpServer();
}
