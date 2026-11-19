import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerGateway } from "../src/modules/docker-gateway/gateway.js";
import { WORKSPACES_PATH, type WorkspaceDescriptor } from "../src/modules/docker-gateway/protocol.js";
import { socketCall } from "../src/modules/docker-gateway/socket-call.js";
import { WorkspaceStore, emptyInProcess } from "../src/modules/docker-gateway/workspaces.js";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;
const PREFETCH = { network: "scvs-prefetch-0a1b2c3d4e5f", proxy: "http://scvs-egress-proxy:3128" };

/** Just enough of the daemon's API for one `docker run --rm`, recording every call that reaches it. */
class FakeDaemon {
  readonly calls: string[] = [];
  readonly removed: string[] = [];
  readonly registryAuth: (string | undefined)[] = [];
  readonly created: string[] = [];
  private readonly exits = new Map<string, () => void>();
  private server?: Server;

  listen(socket: string): Promise<void> {
    const server = createServer((req, res) => {
      const path = (req.url ?? "").replace(/^\/v\d+\.\d+/, "").split("?")[0]!;
      this.calls.push(`${req.method} ${path}`);
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (path === "/containers/create") this.created.push(Buffer.concat(chunks).toString("utf8"));
        const id = path.split("/")[2] ?? "";
        if (path === "/_ping") return void res.writeHead(200).end("OK");
        if (path === "/version") return json(res, 200, { Version: "25.0.5", ApiVersion: "1.44" });
        if (path === "/images/create") {
          this.registryAuth.push(req.headers["x-registry-auth"] as string | undefined);
          return json(res, 200, { status: "Downloaded newer image" });
        }
        if (path === "/containers/create") return json(res, 201, { Id: randomBytes(32).toString("hex"), Warnings: [] });
        if (path.endsWith("/wait")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.flushHeaders();
          this.exits.set(id, () => res.end(JSON.stringify({ StatusCode: 3 })));
          return;
        }
        if (path.endsWith("/start")) {
          setTimeout(() => this.exits.get(id)?.(), 20);
          return void res.writeHead(204).end();
        }
        if (req.method === "DELETE") {
          this.removed.push(id);
          return void res.writeHead(204).end();
        }
        json(res, 404, { message: "no such route in the fake" });
      });
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      this.calls.push(`${req.method} ${(req.url ?? "").replace(/^\/v\d+\.\d+/, "").split("?")[0]}`);
      (socket as Duplex & { allowHalfOpen: boolean }).allowHalfOpen = true;
      socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      socket.write("before-eof;");
      // Output written after the CLI has half-closed its side must still reach it.
      socket.on("end", () => socket.end("after-eof"));
      socket.resume();
    });
    this.server = server;
    return new Promise((resolve) => server.listen(socket, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sandboxBody(source?: string): Record<string, unknown> {
  return {
    User: "65532:65532",
    Image: IMAGE,
    Cmd: ["vendor"],
    HostConfig: {
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Memory: 1 << 30,
      NanoCpus: 1e9,
      PidsLimit: 64,
      NetworkMode: "none",
      AutoRemove: true,
      Mounts: source ? [{ Type: "bind", Source: source, Target: "/source", ReadOnly: true, BindOptions: { NonRecursive: true } }] : null,
    },
  };
}

describe("docker gateway in front of a daemon", () => {
  let dir: string;
  let daemon: FakeDaemon;
  let gateway: DockerGateway;
  let socket: string;
  let logged: { event: string; fields: Record<string, unknown> }[];
  let ecrRequests: { host: string; region: string }[];
  let ecrFails: boolean;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scvs-gw-"));
    daemon = new FakeDaemon();
    await daemon.listen(join(dir, "d.sock"));
    logged = [];
    ecrRequests = [];
    ecrFails = false;
    gateway = new DockerGateway({
      upstreamSocket: join(dir, "d.sock"),
      workspaces: new WorkspaceStore({ parent: dir, empty: emptyInProcess }),
      sandboxUser: "65532:65532",
      log: (event, fields) => logged.push({ event, fields }),
      maxBodyBytes: 64 * 1024,
      ecrAuth: async (registry) => {
        ecrRequests.push(registry);
        if (ecrFails) throw new Error("no instance role");
        return "gateway-token";
      },
      prefetch: PREFETCH,
    });
    socket = join(dir, "g.sock");
    await gateway.listen(socket);
  });

  afterEach(async () => {
    await gateway.shutdown();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });

  const newWorkspace = async () => (await socketCall(socket, "POST", WORKSPACES_PATH)).body as WorkspaceDescriptor;
  const createContainer = async (source?: string) => {
    const response = await socketCall(socket, "POST", "/v1.44/containers/create", sandboxBody(source));
    return { status: response.status, id: (response.body as { Id?: string; message?: string }).Id, body: response.body };
  };

  it("runs a sandbox container the way `docker run` does", async () => {
    const workspace = await newWorkspace();
    const created = await createContainer(workspace.leaves.source);
    expect(created.status).toBe(201);
    const id = created.id!;

    const attached = await attach(socket, id);
    // `docker run` blocks on `/wait`'s headers before it starts the container.
    const waiting = await headersOf(socket, "POST", `/v1.44/containers/${id}/wait?condition=removed`);
    expect(waiting.statusCode).toBe(200);
    expect((await socketCall(socket, "POST", `/v1.44/containers/${id}/start`)).status).toBe(204);

    expect(JSON.parse(await bodyOf(waiting))).toEqual({ StatusCode: 3 });
    expect(await attached).toBe("before-eof;after-eof");
    expect(daemon.calls).toEqual([
      "POST /containers/create",
      `POST /containers/${id}/attach`,
      `POST /containers/${id}/wait`,
      `POST /containers/${id}/start`,
    ]);
  });

  it("hands the runner the prefetch network with each workspace", async () => {
    expect((await newWorkspace()).prefetch).toEqual(PREFETCH);
  });

  it("lets a container join the prefetch network, never a bridge with a route out", async () => {
    const workspace = await newWorkspace();
    const onPrefetch = sandboxBody(workspace.leaves.source);
    (onPrefetch.HostConfig as Record<string, unknown>).NetworkMode = PREFETCH.network;
    expect((await socketCall(socket, "POST", "/v1.44/containers/create", onPrefetch)).status).toBe(201);

    const onBridge = sandboxBody(workspace.leaves.source);
    (onBridge.HostConfig as Record<string, unknown>).NetworkMode = "bridge";
    const refused = await socketCall(socket, "POST", "/v1.44/containers/create", onBridge);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("HostConfig.NetworkMode must be");
    expect(daemon.calls).toEqual(["POST /containers/create"]);
  });

  it("hands the daemon the document it checked, never the runner's bytes", async () => {
    const workspace = await newWorkspace();
    const checked = sandboxBody(workspace.leaves.source);
    // JSON.parse keeps the last User; the raw bytes also carry a first one, which the daemon must never see.
    const raw = `{"User":"0:0",${JSON.stringify(checked).slice(1)}`;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { socketPath: socket, method: "POST", path: "/v1.44/containers/create", headers: { "content-type": "application/json" } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(raw);
    });

    expect(status).toBe(201);
    expect(daemon.created).toEqual([JSON.stringify(checked)]);
  });

  it("refuses a container in any other shape before the daemon sees it", async () => {
    const outside = await mkdtemp(join(dir, "elsewhere-"));
    const created = await createContainer(outside);

    expect(created.status).toBe(403);
    expect(JSON.stringify(created.body)).toContain("is not a directory of a live sandbox workspace");
    expect(daemon.calls).toEqual([]);
    expect(logged.map((entry) => entry.event)).toEqual(["request_refused"]);
  });

  it("touches only the containers created through it", async () => {
    const foreign = "f".repeat(64);
    for (const [method, path] of [
      ["POST", `/v1.44/containers/${foreign}/start`],
      ["POST", `/v1.44/containers/${foreign}/kill`],
      ["DELETE", `/v1.44/containers/${foreign}?force=1`],
      ["GET", `/v1.44/containers/${foreign}/json`],
    ] as const) {
      expect((await socketCall(socket, method, path)).status).toBe(404);
    }
    const upgraded = await rawUpgrade(socket, `/v1.44/containers/${foreign}/attach?stream=1`);
    expect(upgraded).toMatch(/^HTTP\/1\.1 404 /);
    expect(daemon.calls).toEqual([]);
  });

  it("refuses everything the builder never asks for", async () => {
    for (const [method, path] of [
      ["GET", "/v1.44/containers/json"],
      ["GET", "/v1.44/info"],
      ["POST", "/v1.44/build"],
      ["POST", "/v1.44/images/create?fromImage=alpine&tag=latest"],
    ] as const) {
      expect((await socketCall(socket, method, path)).status).toBe(403);
    }
    expect(daemon.calls).toEqual([]);
  });

  it("refuses a start that carries a HostConfig, on any API version, before the daemon sees it", async () => {
    const workspace = await newWorkspace();
    const created = await createContainer(workspace.leaves.source);
    expect(created.status).toBe(201);
    daemon.calls.length = 0;
    const escalation = { Privileged: true, Binds: ["/:/host"], CapAdd: ["ALL"] };

    // Below 1.24 a daemon that still serves the version applies a start's HostConfig; at any version, a body
    // on anything but a create is never checked, so it is never forwarded.
    expect((await socketCall(socket, "POST", `/v1.23/containers/${created.id}/start`, escalation)).status).toBe(403);
    expect((await socketCall(socket, "POST", `/v1.44/containers/${created.id}/start`, escalation)).status).toBe(400);
    expect((await socketCall(socket, "GET", "/v1.12/version")).status).toBe(403);
    expect(daemon.calls).toEqual([]);
  });

  it("authenticates an ECR pull itself, replacing whatever the runner sent", async () => {
    const ecr = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com";
    const response = await pull(socket, `${ecr}%2Fsv-dev-composed-environments`, "runner-token");

    expect(response).toBe(200);
    expect(ecrRequests).toEqual([{ host: ecr, region: "ap-southeast-2" }]);
    expect(daemon.registryAuth).toEqual(["gateway-token"]);
  });

  it("asks for no token for a pull from anywhere else", async () => {
    expect(await pull(socket, "docker.io%2Fstellar%2Fstellar-cli")).toBe(200);
    expect(ecrRequests).toEqual([]);
    expect(daemon.registryAuth).toEqual([undefined]);
  });

  it("refuses an ECR pull it cannot get a token for, before the daemon sees it", async () => {
    ecrFails = true;
    expect(await pull(socket, "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com%2Fx")).toBe(502);
    expect(daemon.calls).toEqual([]);
  });

  it("refuses an oversized request body", async () => {
    const response = await socketCall(socket, "POST", "/v1.44/containers/create", { pad: "x".repeat(128 * 1024) }).catch(
      (error: unknown) => ({ status: 0, body: String(error) }),
    );
    expect([0, 413]).toContain(response.status);
    expect(daemon.calls).toEqual([]);
  });

  it("deleting a workspace removes its containers first, and none of them may start after", async () => {
    const workspace = await newWorkspace();
    const { id } = await createContainer(workspace.leaves.source);

    expect((await socketCall(socket, "DELETE", `${WORKSPACES_PATH}/${workspace.id}`)).status).toBe(204);
    expect(daemon.removed).toEqual([id]);
    await expect(stat(workspace.root)).rejects.toThrow();
    expect((await socketCall(socket, "POST", `/v1.44/containers/${id}/start`)).status).toBe(409);
    expect((await createContainer(workspace.leaves.source)).status).toBe(403);
  });

  it("shutting down removes every container it created and every workspace", async () => {
    const workspace = await newWorkspace();
    const first = await createContainer(workspace.leaves.source);
    const second = await createContainer();

    await gateway.shutdown();

    expect(daemon.removed.sort()).toEqual([first.id, second.id].sort());
    expect((await readdir(dir)).filter((entry) => entry.startsWith("scvs-sandbox-"))).toEqual([]);
  });

  it("makes leaves the sandbox can write and a root it cannot", async () => {
    const workspace = await newWorkspace();
    expect((await stat(workspace.root)).mode & 0o777).toBe(0o750);
    expect((await stat(workspace.leaves.source)).mode & 0o777).toBe(0o755);
    for (const leaf of [workspace.leaves.vendor, workspace.leaves.out, workspace.leaves.cargoHome, workspace.leaves.artifact]) {
      expect((await stat(leaf)).mode & 0o777).toBe(0o777);
    }
  });
});

function pull(socket: string, fromImage: string, registryAuth?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method: "POST",
        path: `/v1.44/images/create?fromImage=${fromImage}&tag=sha256%3A${"a".repeat(64)}`,
        headers: registryAuth ? { "x-registry-auth": registryAuth } : {},
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function attach(socket: string, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: socket,
      method: "POST",
      path: `/v1.44/containers/${id}/attach?stream=1&stdout=1&stderr=1`,
      headers: { connection: "Upgrade", upgrade: "tcp" },
    });
    req.on("upgrade", (_res, conn: Duplex, head: Buffer) => {
      // Whatever arrived with the 101 is the stream's start.
      let output = head.toString();
      conn.on("data", (chunk: Buffer) => (output += chunk.toString()));
      conn.on("end", () => resolve(output));
      // As the CLI does once it has no stdin to send.
      conn.end();
    });
    req.on("response", (res) => reject(new Error(`attach was not upgraded: ${res.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
}

function headersOf(socket: string, method: string, path: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path }, resolve);
    req.on("error", reject);
    req.end();
  });
}

function bodyOf(response: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    response.on("data", (chunk: Buffer) => (body += chunk.toString()));
    response.on("end", () => resolve(body));
  });
}

function rawUpgrade(socket: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: "POST", path, headers: { connection: "Upgrade", upgrade: "tcp" } });
    req.on("response", (res) => resolve(`HTTP/1.1 ${res.statusCode} `));
    req.on("upgrade", () => reject(new Error("upgraded")));
    req.on("error", reject);
    req.end();
  });
}
