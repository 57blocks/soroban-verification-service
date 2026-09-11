import type { Server } from "node:http";
import { bootstrap } from "../src/main.js";

export async function createTestServer(): Promise<Server> {
  const app = await bootstrap();
  return app.getHttpServer();
}
