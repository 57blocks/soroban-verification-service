import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { LogFields } from "@scvs/core";
import { checkAuth, checkCreate, checkPull, routeRequest, type Denial } from "./policy.js";
import type { WorkspaceStore } from "./workspaces.js";

export type GatewayLog = (event: string, fields: LogFields) => void;

export type DockerGatewayOptions = {
  /** The host daemon's socket. Only the gateway holds it. */
  upstreamSocket: string;
  workspaces: WorkspaceStore;
  sandboxUser: string;
  log: GatewayLog;
  maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

class RequestRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The runner's only way to the host's Docker daemon. It forwards the few calls a sandbox stage makes, refuses
 * every other, and lets the runner touch only the containers it created here.
 */
export class DockerGateway {
  private server?: Server;
  /** Container id → the workspaces its binds belong to. */
  private readonly containers = new Map<string, string[]>();

  constructor(private readonly options: DockerGatewayOptions) {}

  listen(socketPath: string): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => this.refuse(res, error, req));
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(req, socket, head).catch((error: unknown) => {
        this.logRefusal(req, error);
        writeRawResponse(socket, error instanceof RequestRefused ? error.status : 502, errorMessage(error));
      });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  /** Removes every container created here and every workspace, then stops listening. */
  async shutdown(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections();
    for (const id of this.containers.keys()) await this.removeContainer(id);
    for (const id of this.options.workspaces.ids()) {
      await this.options.workspaces.delete(id).catch((error: unknown) =>
        this.options.log("workspace_delete_failed", { workspace: id, detail: errorMessage(error) }),
      );
    }
  }

  ownsContainer(id: string): boolean {
    return this.containers.has(id);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = routeRequest(req.method ?? "", req.url ?? "");
    if (!route.ok) throw refused(403, route);
    const body = await readBody(req, this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);

    switch (route.kind) {
      case "ping":
      case "version":
        return this.forward(req, res, body);
      case "auth": {
        const check = checkAuth(parseJson(body));
        if (!check.ok) throw refused(403, check);
        return this.forward(req, res, body);
      }
      case "pull": {
        const check = checkPull(req.url ?? "");
        if (!check.ok) throw refused(403, check);
        return this.forward(req, res, body);
      }
      case "create": {
        const workspaces = this.options.workspaces;
        const check = checkCreate(req.url ?? "", parseJson(body), {
          sandboxUser: this.options.sandboxUser,
          workspaceOfLeaf: (path) => workspaces.workspaceOfLeaf(path),
        });
        if (!check.ok) throw refused(403, check);
        return this.forward(req, res, body, (status, response) => {
          const id = (parseJson(response) as { Id?: unknown } | undefined)?.Id;
          if (status === 201 && typeof id === "string") this.containers.set(id, check.workspaces);
        });
      }
      case "container": {
        const workspaces = this.containers.get(route.id);
        if (!workspaces) throw new RequestRefused(404, `no container ${route.id} was created through this gateway`);
        if (route.op === "start") {
          const gone = workspaces.find((id) => !this.options.workspaces.isLive(id));
          if (gone) throw new RequestRefused(409, `workspace ${gone} was deleted, so its container may not start`);
        }
        return this.forward(req, res, body);
      }
      case "workspace-create": {
        const workspace = await this.options.workspaces.create();
        this.options.log("workspace_created", { workspace: workspace.id });
        return sendJson(res, 201, workspace);
      }
      case "workspace-delete": {
        if (!this.options.workspaces.isLive(route.id)) throw new RequestRefused(404, `no workspace ${route.id}`);
        for (const [id, workspaces] of this.containers) {
          if (workspaces.includes(route.id)) await this.removeContainer(id);
        }
        await this.options.workspaces.delete(route.id);
        this.options.log("workspace_deleted", { workspace: route.id });
        res.writeHead(204).end();
        return;
      }
    }
  }

  private async handleUpgrade(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const route = routeRequest(req.method ?? "", req.url ?? "");
    if (!route.ok) throw refused(403, route);
    if (route.kind !== "container" || route.op !== "attach") throw new RequestRefused(403, "only an attach may upgrade");
    if (!this.containers.has(route.id)) throw new RequestRefused(404, `no container ${route.id} was created through this gateway`);

    const upstream = request({
      socketPath: this.options.upstreamSocket,
      method: req.method,
      path: req.url,
      headers: { ...forwardedHeaders(req.headers, 0), connection: "Upgrade", upgrade: req.headers.upgrade ?? "tcp" },
    });
    upstream.on("upgrade", (response: IncomingMessage, daemon: Duplex, daemonHead: Buffer) => {
      // The CLI half-closes once it has no more stdin; the container's output must still come back.
      (client as Duplex & { allowHalfOpen: boolean }).allowHalfOpen = true;
      (daemon as Duplex & { allowHalfOpen: boolean }).allowHalfOpen = true;
      client.write(statusLine(response) + rawHeaderLines(response.rawHeaders) + "\r\n");
      if (daemonHead.length) client.write(daemonHead);
      if (head.length) daemon.write(head);
      daemon.on("error", () => client.destroy());
      client.on("error", () => daemon.destroy());
      daemon.pipe(client);
      client.pipe(daemon);
    });
    upstream.on("response", (response: IncomingMessage) => {
      client.write(statusLine(response) + rawHeaderLines(response.rawHeaders) + "\r\n");
      response.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    upstream.end();
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    onBody?: (status: number, body: Buffer) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const upstream = request(
        {
          socketPath: this.options.upstreamSocket,
          method: req.method,
          path: req.url,
          headers: forwardedHeaders(req.headers, body.length),
        },
        (response) => {
          const status = response.statusCode ?? 502;
          res.writeHead(status, returnedHeaders(response.headers));
          response.on("error", reject);
          if (!onBody) {
            // The CLI waits for `/wait`'s headers, which the daemon flushes at once, before it starts the container.
            res.flushHeaders();
            response.pipe(res);
            response.on("end", () => resolve());
            return;
          }
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const buffer = Buffer.concat(chunks);
            onBody(status, buffer);
            res.end(buffer);
            resolve();
          });
        },
      );
      upstream.on("error", reject);
      // The daemon would otherwise outlive a CLI that went away mid-stream.
      res.on("close", () => upstream.destroy());
      upstream.end(body);
    });
  }

  private async removeContainer(id: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const upstream = request(
        { socketPath: this.options.upstreamSocket, method: "DELETE", path: `/containers/${id}?force=1` },
        (response) => {
          response.resume();
          response.on("end", () => resolve());
        },
      );
      upstream.on("error", () => resolve());
      upstream.end();
    });
  }

  private refuse(res: ServerResponse, error: unknown, req: IncomingMessage): void {
    this.logRefusal(req, error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, error instanceof RequestRefused ? error.status : 502, { message: `scvs docker gateway: ${errorMessage(error)}` });
  }

  private logRefusal(req: IncomingMessage, error: unknown): void {
    this.options.log(error instanceof RequestRefused ? "request_refused" : "request_failed", {
      method: req.method,
      path: (req.url ?? "").split("?")[0],
      ...(error instanceof RequestRefused ? { status: error.status } : {}),
      detail: errorMessage(error),
    });
  }
}

function refused(status: number, denial: Denial): RequestRefused {
  return new RequestRefused(status, denial.reason);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RequestRefused(413, `request body over ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(body: Buffer): unknown {
  if (!body.length) return undefined;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders, bodyLength: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === "content-length") continue;
    out[name] = value;
  }
  if (bodyLength > 0 || headers["content-length"] !== undefined) out["content-length"] = String(bodyLength);
  return out;
}

function returnedHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function statusLine(response: IncomingMessage): string {
  return `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}\r\n`;
}

function rawHeaderLines(raw: string[]): string {
  let lines = "";
  for (let i = 0; i + 1 < raw.length; i += 2) lines += `${raw[i]}: ${raw[i + 1]}\r\n`;
  return lines;
}

function writeRawResponse(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ message: `scvs docker gateway: ${message}` });
  socket.end(
    `HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
