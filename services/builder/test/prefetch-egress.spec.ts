import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, LineSplitter, PrefetchEgressHost } from "../src/modules/docker-gateway/prefetch-egress.js";

const IMAGE = `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-builder@sha256:${"b".repeat(64)}`;
const PROXY_ID = "e".repeat(64);
const LISTENING = JSON.stringify({ ts: "t", level: "log", component: "egress-proxy", msg: "egress_proxy_listening", port: 3128 });

/** A daemon that records what the gateway asks of it, and plays the proxy's log back as Docker frames it. */
class FakeDaemon {
  readonly calls: { method: string; path: string; body: any }[] = [];
  proxyLog: string[] = [LISTENING];
  failNetwork = false;
  private server?: Server;

  listen(socket: string): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        this.calls.push({ method: req.method ?? "", path, body });
        this.answer(req.method ?? "", path, res);
      });
    });
    return new Promise((resolve) => this.server!.listen(socket, resolve));
  }

  private answer(method: string, path: string, res: ServerResponse): void {
    if (path === "/networks/create") {
      if (this.failNetwork && this.calls.filter((c) => c.path === "/networks/create").length === 2) return json(res, 500, { message: "pool exhausted" });
      return json(res, 201, { Id: "n".repeat(64) });
    }
    if (path.startsWith("/containers/create")) return json(res, 201, { Id: PROXY_ID });
    if (path.endsWith("/connect")) return void res.writeHead(200).end();
    if (path.endsWith("/start")) return void res.writeHead(204).end();
    if (path.startsWith(`/containers/${PROXY_ID}/logs`)) {
      res.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" });
      // One frame split across two writes, to exercise reassembly.
      const frames = Buffer.concat(this.proxyLog.map((line) => frame(2, `${line}\n`)));
      res.write(frames.subarray(0, 5));
      res.end(frames.subarray(5));
      return;
    }
    if (method === "DELETE") return void res.writeHead(204).end();
    json(res, 404, { message: "no such route in the fake" });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }
}

function frame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

describe("the gateway's prefetch network", () => {
  let dir: string;
  let daemon: FakeDaemon;
  let forwarded: string[];
  let host: PrefetchEgressHost;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scvs-pe-"));
    daemon = new FakeDaemon();
    await daemon.listen(join(dir, "d.sock"));
    forwarded = [];
    host = new PrefetchEgressHost({
      socket: join(dir, "d.sock"),
      image: IMAGE,
      allowedHosts: ["crates.io", "github.com"],
      user: "65532:65532",
      log: () => undefined,
      forward: (line) => forwarded.push(line),
      readyTimeoutMs: 2_000,
    });
  });

  afterEach(async () => {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("puts the proxy on an internal network and a bridge of its own, in the sandbox's shape", async () => {
    const egress = await host.start();

    const networks = daemon.calls.filter((call) => call.path === "/networks/create").map((call) => call.body);
    expect(networks).toHaveLength(2);
    const [outward, internal] = networks;
    expect(outward).toMatchObject({ Driver: "bridge", Internal: false, Attachable: false, EnableIPv6: false });
    expect(internal).toMatchObject({ Name: egress.network, Driver: "bridge", Internal: true, Attachable: false, EnableIPv6: false });
    expect(egress).toEqual({ network: expect.stringMatching(/^scvs-prefetch-[0-9a-f]{12}$/), proxy: "http://scvs-egress-proxy:3128" });

    const proxy = daemon.calls.find((call) => call.path.startsWith("/containers/create"))!.body;
    expect(proxy).toMatchObject({
      Image: IMAGE,
      User: "65532:65532",
      Entrypoint: ["node", "/app/services/builder/dist/egress-proxy-entrypoint.js"],
      Env: expect.arrayContaining(["SCVS_PREFETCH_ALLOWED_HOSTS=crates.io,github.com"]),
      HostConfig: {
        NetworkMode: outward.Name,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
      },
    });
    expect(proxy.HostConfig.Memory).toBeGreaterThan(0);
    expect(proxy.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(proxy.HostConfig.Mounts).toBeUndefined();
    expect(proxy.HostConfig.Binds).toBeUndefined();

    const connect = daemon.calls.find((call) => call.path.endsWith("/connect"))!;
    expect(connect.path).toBe(`/networks/${egress.network}/connect`);
    expect(connect.body).toEqual({ Container: PROXY_ID, EndpointConfig: { Aliases: ["scvs-egress-proxy"] } });
    // Joined to the internal network before it starts, and ready only once it says it is listening.
    const order = daemon.calls.map((call) => call.path.split("?")[0]);
    expect(order.indexOf(connect.path)).toBeLessThan(order.indexOf(`/containers/${PROXY_ID}/start`));
    expect(forwarded).toEqual([LISTENING]);
  });

  it("removes the proxy and both networks when it stops", async () => {
    const egress = await host.start();
    daemon.calls.length = 0;

    await host.stop();
    await host.stop();

    expect(daemon.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /containers/${PROXY_ID}?force=1`,
      `DELETE /networks/${egress.network}`,
      expect.stringMatching(/^DELETE \/networks\/scvs-egress-[0-9a-f]{12}$/),
    ]);
  });

  it("fails, and leaves nothing behind, when the proxy exits before it listens", async () => {
    daemon.proxyLog = [JSON.stringify({ msg: "egress_proxy_failed", detail: "boom" })];

    await expect(host.start()).rejects.toThrow("the egress proxy exited");

    const removed = daemon.calls.filter((call) => call.method === "DELETE").map((call) => call.path);
    expect(removed).toEqual([
      `/containers/${PROXY_ID}?force=1`,
      expect.stringMatching(/^\/networks\/scvs-prefetch-/),
      expect.stringMatching(/^\/networks\/scvs-egress-/),
    ]);
  });

  it("removes the network it made when the second cannot be made", async () => {
    daemon.failNetwork = true;

    await expect(host.start()).rejects.toThrow("pool exhausted");

    expect(daemon.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      expect.stringMatching(/^\/networks\/scvs-egress-/),
    ]);
  });
});

describe("reading a container's log stream", () => {
  it("reassembles frames and lines across chunk boundaries", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    const reader = new FrameReader((payload) => splitter.push(payload));
    const stream = Buffer.concat([frame(1, "first li"), frame(2, "ne\nsecond\n"), frame(1, "tail")]);
    for (let i = 0; i < stream.length; i += 3) reader.push(stream.subarray(i, i + 3));
    splitter.flush();

    expect(lines).toEqual(["first line", "second", "tail"]);
  });
});
