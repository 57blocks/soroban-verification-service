import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { GatewayLog } from "./gateway.js";
import { EGRESS_PROXY_ALIAS, EGRESS_PROXY_PORT, type PrefetchEgress } from "./protocol.js";
import { socketCall, type SocketResponse } from "./socket-call.js";

export const EGRESS_PROXY_ENTRYPOINT = ["node", "/app/services/builder/dist/egress-proxy-entrypoint.js"];
const READY_TIMEOUT_MS = 30_000;
/** Each set-up and tear-down call to the daemon: one that stops answering must fail the stage, not hold it. */
const DAEMON_CALL_TIMEOUT_MS = 30_000;
const OWNER_LABEL = "scvs.docker-gateway";

export type PrefetchEgressOptions = {
  /** The host daemon's socket. */
  socket: string;
  /** The builder's own image, which carries the proxy. */
  image: string;
  allowedHosts: readonly string[];
  /** The sandbox's uid: the proxy holds no more than a stage does. */
  user: string;
  log: GatewayLog;
  /** Each line the proxy logs, passed on as it is. */
  forward: (line: string) => void;
  readyTimeoutMs?: number;
};

/**
 * The network a prefetch stage joins, made by the gateway for its own job. The prefetch network is internal:
 * Docker gives it no route off the host. Its one other member is the egress proxy, which also sits on a bridge
 * of its own with a route out, and which the runner can neither address nor reconfigure.
 */
export class PrefetchEgressHost {
  private readonly suffix = randomBytes(6).toString("hex");
  private readonly internalName = `scvs-prefetch-${this.suffix}`;
  private readonly egressName = `scvs-egress-${this.suffix}`;
  private proxyId?: string;
  private readonly networks: string[] = [];

  constructor(private readonly options: PrefetchEgressOptions) {}

  async start(): Promise<PrefetchEgress> {
    try {
      await this.createNetwork(this.egressName, false);
      await this.createNetwork(this.internalName, true);
      const id = await this.createProxy();
      const connected = await this.call("POST", `/networks/${this.internalName}/connect`, {
        Container: id,
        EndpointConfig: { Aliases: [EGRESS_PROXY_ALIAS] },
      });
      expect(connected, [200], "connect the proxy to the prefetch network");
      expect(await this.call("POST", `/containers/${id}/start`), [204], "start the egress proxy");
      // A followed log replays from the start, so a line written before this request is not missed.
      await this.followLogs(id);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.options.log("prefetch_network_ready", { network: this.internalName, egress_network: this.egressName });
    return { network: this.internalName, proxy: `http://${EGRESS_PROXY_ALIAS}:${EGRESS_PROXY_PORT}` };
  }

  /** Removes the proxy and both networks. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.proxyId) {
      await this.call("DELETE", `/containers/${this.proxyId}?force=1`).catch(() => undefined);
      this.proxyId = undefined;
    }
    for (const name of this.networks.splice(0).reverse()) {
      const removed = await this.call("DELETE", `/networks/${name}`).catch((error: unknown) => ({ status: 0, body: String(error) }));
      if (removed.status !== 204 && removed.status !== 404) {
        this.options.log("prefetch_network_remove_failed", { network: name, status: removed.status });
      }
    }
  }

  private async createNetwork(name: string, internal: boolean): Promise<void> {
    const created = await this.call("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Internal: internal,
      Attachable: false,
      EnableIPv6: false,
      Labels: { [OWNER_LABEL]: this.suffix },
      // The proxy is the egress bridge's only member, and nothing on it needs to reach another container.
      Options: internal ? {} : { "com.docker.network.bridge.enable_icc": "false" },
    });
    expect(created, [201], `create network ${name}`);
    this.networks.push(name);
  }

  private async createProxy(): Promise<string> {
    const created = await this.call("POST", `/containers/create?name=scvs-egress-proxy-${this.suffix}`, {
      Image: this.options.image,
      User: this.options.user,
      Entrypoint: EGRESS_PROXY_ENTRYPOINT,
      Cmd: [],
      Env: [`SCVS_PREFETCH_ALLOWED_HOSTS=${this.options.allowedHosts.join(",")}`, "NODE_ENV=production"],
      Labels: { [OWNER_LABEL]: this.suffix },
      HostConfig: {
        NetworkMode: this.egressName,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Memory: 256 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 128,
        RestartPolicy: { Name: "no" },
      },
      NetworkingConfig: { EndpointsConfig: { [this.egressName]: {} } },
    });
    expect(created, [201], "create the egress proxy");
    const id = (created.body as { Id?: unknown } | undefined)?.Id;
    if (typeof id !== "string") throw new Error("the daemon returned no id for the egress proxy");
    this.proxyId = id;
    return id;
  }

  /** Passes each line on, and resolves once the proxy says it is listening; rejects if it exits first. */
  private followLogs(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new Error(`the egress proxy did not start listening within ${this.options.readyTimeoutMs ?? READY_TIMEOUT_MS} ms`)),
        this.options.readyTimeoutMs ?? READY_TIMEOUT_MS,
      );
      const req = request(
        { socketPath: this.options.socket, method: "GET", path: `/containers/${id}/logs?follow=1&stdout=1&stderr=1` },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            settle(new Error(`could not follow the egress proxy's log (${response.statusCode})`));
            return;
          }
          const lines = new LineSplitter((line) => {
            this.options.forward(line);
            if (isListening(line)) settle();
          });
          const frames = new FrameReader((payload) => lines.push(payload));
          response.on("data", (chunk: Buffer) => frames.push(chunk));
          response.on("end", () => {
            lines.flush();
            settle(new Error("the egress proxy exited"));
          });
          response.on("error", () => settle(new Error("lost the egress proxy's log")));
        },
      );
      req.on("error", (error) => settle(error));
      req.end();
    });
  }

  private call(method: string, path: string, body?: unknown): Promise<SocketResponse> {
    return socketCall(this.options.socket, method, path, body, { timeoutMs: DAEMON_CALL_TIMEOUT_MS });
  }
}

/** Older than the longest a live gateway takes between making an object and putting it to use. */
const LEFTOVER_MIN_AGE_MS = 10 * 60_000;
/** A daemon that stops answering must not hold the gateway's start: the reaping is a courtesy, not a step. */
const REAP_TIMEOUT_MS = 30_000;

/**
 * Removes what a gateway that died without stopping (OOM, SIGKILL) left on this daemon: its stopped egress proxy
 * and its networks. Only objects carrying the gateway's label and older than a live gateway's set-up window are
 * touched, a running container never is, and a network still in use is refused by the daemon and left. Never
 * throws: a gateway starts whether or not anything could be removed.
 */
export async function reapPrefetchLeftovers(
  socket: string,
  log: GatewayLog,
  now = Date.now(),
  minAgeMs = LEFTOVER_MIN_AGE_MS,
  timeoutMs = REAP_TIMEOUT_MS,
): Promise<{ containers: number; networks: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gaveUp = false;
  // Once given up, the reaping's own late failure is not logged a second time.
  const reapLog: GatewayLog = (...args) => {
    if (!gaveUp) log(...args);
  };
  const timedOut = new Promise<{ containers: number; networks: number }>((resolve) => {
    timer = setTimeout(() => {
      gaveUp = true;
      log("prefetch_leftovers_unreaped", { error: `the daemon did not answer within ${timeoutMs} ms` });
      resolve({ containers: 0, networks: 0 });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reap(socket, reapLog, now, minAgeMs, timeoutMs), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function reap(
  socket: string,
  log: GatewayLog,
  now: number,
  minAgeMs: number,
  timeoutMs: number,
): Promise<{ containers: number; networks: number }> {
  // Each call is bounded too, so nothing is left waiting on the daemon after the overall limit gives up.
  const call = (method: string, path: string) => socketCall(socket, method, path, undefined, { timeoutMs });
  const filter = encodeURIComponent(JSON.stringify({ label: [OWNER_LABEL] }));
  const cutoff = now - minAgeMs;
  let containers = 0;
  let networks = 0;
  try {
    const listed = await call("GET", `/containers/json?all=1&filters=${filter}`);
    for (const container of Array.isArray(listed.body) ? (listed.body as { Id?: unknown; State?: unknown; Created?: unknown }[]) : []) {
      if (typeof container.Id !== "string" || container.State === "running") continue;
      if (typeof container.Created !== "number" || container.Created * 1000 >= cutoff) continue;
      const removed = await call("DELETE", `/containers/${container.Id}?force=1`);
      if (removed.status === 204 || removed.status === 404) containers += 1;
    }
    const nets = await call("GET", `/networks?filters=${filter}`);
    for (const network of Array.isArray(nets.body) ? (nets.body as { Id?: unknown; Created?: unknown }[]) : []) {
      if (typeof network.Id !== "string" || typeof network.Created !== "string") continue;
      const created = Date.parse(network.Created);
      if (!Number.isFinite(created) || created >= cutoff) continue;
      // A network with a container still attached is refused (403/409) and stays, as it should.
      const removed = await call("DELETE", `/networks/${network.Id}`);
      if (removed.status === 204 || removed.status === 404) networks += 1;
    }
  } catch (error) {
    log("prefetch_leftovers_unreaped", { error: error instanceof Error ? error.message : String(error) });
    return { containers, networks };
  }
  if (containers || networks) log("prefetch_leftovers_reaped", { containers, networks });
  return { containers, networks };
}

function expect(response: SocketResponse, statuses: number[], what: string): void {
  if (!statuses.includes(response.status)) {
    throw new Error(`could not ${what} (${response.status}): ${JSON.stringify(response.body)}`);
  }
}

function isListening(line: string): boolean {
  try {
    return (JSON.parse(line) as { msg?: unknown }).msg === "egress_proxy_listening";
  } catch {
    return false;
  }
}

/** Docker's log stream for a container with no TTY: an 8-byte header (stream, 0, 0, 0, length) before each frame. */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  constructor(private readonly onPayload: (payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const length = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + length) return;
      this.onPayload(this.buffer.subarray(8, 8 + length));
      this.buffer = this.buffer.subarray(8 + length);
    }
  }
}

export class LineSplitter {
  private pending = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(payload: Buffer): void {
    const parts = (this.pending + payload.toString("utf8")).split("\n");
    this.pending = parts.pop() ?? "";
    for (const line of parts) if (line) this.onLine(line);
  }

  flush(): void {
    if (this.pending) this.onLine(this.pending);
    this.pending = "";
  }
}
