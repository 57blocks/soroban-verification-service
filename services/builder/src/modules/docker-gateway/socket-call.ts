import { request } from "node:http";

export type SocketResponse = { status: number; body: unknown };

/** One JSON call over a unix socket: the gateway to the host daemon, or the runner to the gateway. */
export function socketCall(socketPath: string, method: string, path: string, body?: unknown): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            // Not JSON: keep the text.
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
