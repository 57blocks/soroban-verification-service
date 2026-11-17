import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { hostMatches } from "../builder/egress-policy.js";

/**
 * The prefetch stage's only way off the host. It opens a CONNECT tunnel to port 443 of an allowlisted host name,
 * after resolving that name itself and refusing it if any address is not a public one. It connects to the
 * address it checked, so a second lookup cannot point the tunnel somewhere else.
 */

export type EgressLog = (event: string, fields: Record<string, string | number | boolean | undefined>) => void;

export type EgressProxyOptions = {
  allowedHosts: readonly string[];
  log: EgressLog;
  /** Every address the name resolves to. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens the tunnel's upstream to the address that passed the check. */
  connectTo?: (address: string, port: number) => Socket;
  /** Defaults to 443 only. */
  ports?: readonly number[];
  maxConnections?: number;
  resolveTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** A tunnel with no traffic either way for this long is closed. */
  idleTimeoutMs?: number;
};

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Every range that is not the public internet: private, shared, loopback, link-local, documentation, multicast. */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  // An IPv4-mapped address (::ffff:a.b.c.d) is checked against the IPv4 ranges above by BlockList itself.
  ["::", 127],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  const allowed = options.allowedHosts.map((host) => host.toLowerCase());
  const ports = options.ports ?? [443];
  const resolve = options.resolve ?? resolveAll;
  const server = createServer((req, res) => {
    options.log("egress_denied", { method: req.method, reason: "only CONNECT is proxied" });
    res.writeHead(405, { "content-type": "text/plain", connection: "close" }).end("only CONNECT tunnels are proxied\n");
  });
  server.maxConnections = options.maxConnections ?? 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;

  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    void tunnel(req, client as Socket, head).catch((error: unknown) => {
      options.log("egress_failed", { target: req.url, detail: error instanceof Error ? error.message : String(error) });
      client.destroy();
    });
  });

  async function tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const target = parseAuthority(req.url ?? "");
    if (!target) return deny(client, 400, req.url ?? "", undefined, "the target is not host:port");
    const { host, port } = target;
    if (!ports.includes(port)) return deny(client, 403, host, port, `port ${port} is not allowed`);
    if (!allowed.some((entry) => hostMatches(host, entry))) return deny(client, 403, host, port, "host is not in the allowlist");

    let addresses: string[];
    try {
      addresses = await withTimeout(resolve(host), options.resolveTimeoutMs ?? 10_000, "name resolution timed out");
    } catch (error) {
      return deny(client, 502, host, port, `could not resolve: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (addresses.length === 0) return deny(client, 502, host, port, "resolved to no address");
    const blocked = addresses.find((address) => !isPublicAddress(address));
    if (blocked) return deny(client, 403, host, port, `resolves to ${blocked}, which is not a public address`);
    // The bridge the proxy sits on carries IPv4 only.
    const address = addresses.find((candidate) => isIP(candidate) === 4) ?? addresses[0]!;
    if (client.destroyed) return;

    const upstream = (options.connectTo ?? defaultConnect)(address, port);
    let connected = false;
    upstream.setTimeout(options.connectTimeoutMs ?? 15_000, () => upstream.destroy(new Error("connect timed out")));
    upstream.once("error", (error) => {
      if (connected) client.destroy();
      else deny(client, 502, host, port, `could not connect to ${address}: ${error.message}`);
    });
    upstream.once("connect", () => {
      connected = true;
      const idle = options.idleTimeoutMs ?? 120_000;
      upstream.setTimeout(idle, () => upstream.destroy());
      client.setTimeout(idle, () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      options.log("egress_opened", { host, port, address });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => {
        client.destroy();
        options.log("egress_closed", { host, port, bytes_out: upstream.bytesWritten, bytes_in: upstream.bytesRead });
      });
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }

  function deny(client: Duplex, status: number, host: string, port: number | undefined, reason: string): void {
    options.log("egress_denied", { host, port, status, reason });
    if (client.destroyed) return;
    const body = `${reason}\n`;
    client.end(
      `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Bad Gateway"}\r\n` +
        `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  return server;
}

/** `host:port` with a DNS name, never an address literal: the allowlist names hosts. */
export function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^([^:\s/@[\]]+):(\d{1,5})$/.exec(authority);
  if (!match) return undefined;
  const host = match[1]!.toLowerCase();
  const port = Number(match[2]);
  if (isIP(host) !== 0 || !HOST_NAME.test(host) || port < 1 || port > 65_535) return undefined;
  return { host, port };
}

function defaultConnect(address: string, port: number): Socket {
  return connect({ host: address, port });
}

async function resolveAll(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
