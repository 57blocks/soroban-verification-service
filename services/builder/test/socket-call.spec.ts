import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketCall } from "../src/modules/docker-gateway/socket-call.js";

describe("socketCall", () => {
  let dir: string;
  let server: Server;
  let answer: boolean;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "socket-call-"));
    answer = true;
    server = createServer((req, res) => {
      if (!answer) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(join(dir, "d.sock"), resolve));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the daemon's answer within the limit", async () => {
    await expect(socketCall(join(dir, "d.sock"), "GET", "/_ping", undefined, { timeoutMs: 1_000 })).resolves.toEqual({
      status: 200,
      body: { path: "/_ping" },
    });
  });

  it("fails a call the daemon never answers, once the limit passes", async () => {
    answer = false;
    const started = Date.now();
    await expect(socketCall(join(dir, "d.sock"), "POST", "/networks/create", {}, { timeoutMs: 150 })).rejects.toThrow(
      "POST /networks/create: the daemon did not answer within 150 ms",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
