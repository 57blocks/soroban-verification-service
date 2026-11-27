import { once } from "node:events";
import { createServer as createTcpServer, connect, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { createEgressProxy, isPublicAddress, parseAuthority } from "../src/modules/egress-proxy/egress-proxy.js";

const ALLOWED = ["crates.io", "github.com"];
const PUBLIC = "93.184.216.34";

describe("the prefetch egress proxy", () => {
  let upstream: TcpServer;
  let upstreamSockets: Socket[];
  let upstreamPort: number;
  let proxy: Server;
  let proxyPort: number;
  let resolved: string[];
  let answers: Record<string, string[] | Error>;
  let dialled: [string, number][];
  let logged: [string, Record<string, unknown>][];

  beforeEach(async () => {
    upstreamSockets = [];
    upstream = createTcpServer((socket) => {
      upstreamSockets.push(socket);
      socket.pipe(socket);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    upstreamPort = (upstream.address() as AddressInfo).port;
    resolved = [];
    dialled = [];
    logged = [];
    answers = { "crates.io": [PUBLIC], "index.crates.io": [PUBLIC], "github.com": [PUBLIC] };
    proxy = createEgressProxy({
      allowedHosts: ALLOWED,
      log: (event, fields) => logged.push([event, fields]),
      resolve: async (host) => {
        resolved.push(host);
        const answer = answers[host];
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
      // Stands in for the internet: the tunnel lands on the local echo server, whatever public address passed.
      connectTo: (address, port) => {
        dialled.push([address, port]);
        return connect({ host: "127.0.0.1", port: upstreamPort });
      },
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterEach(async () => {
    proxy.closeAllConnections();
    upstreamSockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  it("tunnels to port 443 of an allowlisted host, through the address it checked", async () => {
    const client = connect({ host: "127.0.0.1", port: proxyPort });
    const received = collect(client);
    client.write("CONNECT index.crates.io:443 HTTP/1.1\r\nHost: index.crates.io:443\r\n\r\nearly-bytes;");
    await received.until("\r\n\r\n");
    client.write("later-bytes");
    const text = await received.until("later-bytes");
    client.destroy();
    // The bytes sent with the CONNECT reach the upstream first, then everything after the 200.
    expect(text).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nearly-bytes;later-bytes$/);

    expect(resolved).toEqual(["index.crates.io"]);
    expect(dialled).toEqual([[PUBLIC, 443]]);
    expect(logged.map(([event]) => event)).toContain("egress_opened");
  });

  it.each([
    ["a host off the allowlist", "example.com:443", 403, "not in the allowlist"],
    ["a look-alike of an allowlisted host", "evilcrates.io:443", 403, "not in the allowlist"],
    ["a port other than 443", "crates.io:22", 403, "port 22 is not allowed"],
    ["an address literal", "169.254.169.254:443", 400, "not host:port"],
    ["an IPv6 literal", "[::1]:443", 400, "not host:port"],
    ["no port", "crates.io", 400, "not host:port"],
    ["credentials", "user@crates.io:443", 400, "not host:port"],
  ])("refuses %s before resolving anything", async (_name, target, status, reason) => {
    const response = await connectThrough(proxyPort, target);
    expect(response).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
    expect(response).toContain(reason);
    expect(resolved).toEqual([]);
    expect(dialled).toEqual([]);
  });

  it.each([
    ["the VPC", ["10.0.1.20"]],
    ["the metadata service", ["169.254.169.254"]],
    ["the host itself", ["127.0.0.1"]],
    ["shared address space", ["100.64.0.9"]],
    ["a docker bridge", ["172.17.0.1"]],
    ["IPv6 loopback", ["::1"]],
    ["an IPv4-mapped private address", ["::ffff:10.0.0.1"]],
    ["an IPv4-compatible metadata address", ["::a9fe:a9fe"]],
    ["IPv6 unique-local", ["fd00::1"]],
    ["a private address among public ones", [PUBLIC, "10.0.0.2"]],
  ])("refuses an allowlisted name that resolves to %s", async (_name, addresses) => {
    answers["crates.io"] = addresses;
    const response = await connectThrough(proxyPort, "crates.io:443");
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response).toContain("not a public address");
    expect(dialled).toEqual([]);
  });

  it("reports a name it could not resolve", async () => {
    answers["github.com"] = new Error("ENOTFOUND");
    const response = await connectThrough(proxyPort, "github.com:443");
    expect(response).toMatch(/^HTTP\/1\.1 502 /);
    expect(dialled).toEqual([]);
  });

  it("proxies nothing but CONNECT", async () => {
    const client = connect({ host: "127.0.0.1", port: proxyPort });
    const received = collect(client);
    client.write("GET http://crates.io/ HTTP/1.1\r\nHost: crates.io\r\n\r\n");
    expect(await received.until("\r\n\r\n")).toMatch(/^HTTP\/1\.1 405 /);
    client.destroy();
    expect(resolved).toEqual([]);
  });
});

describe("what counts as a public address", () => {
  it.each([
    ["93.184.216.34", true],
    ["2606:2800:220:1:248:1893:25c8:1946", true],
    ["10.1.2.3", false],
    ["172.31.255.255", false],
    ["192.168.0.1", false],
    ["100.127.0.1", false],
    ["169.254.169.253", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["::", false],
    ["::1", false],
    ["fe80::1", false],
    ["64:ff9b::a00:1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:93.184.216.34", false],
    ["::a9fe:a9fe", false],
    ["::169.254.169.254", false],
    ["::5db8:d822", false],
    ["::1:0:0:0", true],
    ["8.8.8.8", true],
    ["not-an-address", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it("reads host:port with a DNS name only", () => {
    expect(parseAuthority("Static.Crates.IO:443")).toEqual({ host: "static.crates.io", port: 443 });
    expect(parseAuthority("crates.io:0")).toBeUndefined();
    expect(parseAuthority("localhost:443")).toBeUndefined();
    expect(parseAuthority("-bad.example:443")).toBeUndefined();
  });
});

async function connectThrough(port: number, target: string): Promise<string> {
  const client = connect({ host: "127.0.0.1", port });
  client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const chunks: Buffer[] = [];
  client.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(client, "close");
  return Buffer.concat(chunks).toString("utf8");
}

/** Everything the socket has received so far, and a wait for a marker in it. */
function collect(socket: Socket): { until: (marker: string) => Promise<string> } {
  let text = "";
  const waiters: (() => void)[] = [];
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    waiters.splice(0).forEach((wake) => wake());
  });
  socket.on("close", () => waiters.splice(0).forEach((wake) => wake()));
  return {
    until: async (marker) => {
      while (!text.includes(marker) && !socket.destroyed) await new Promise<void>((wake) => waiters.push(wake));
      return text;
    },
  };
}
