import { request } from "node:http";

export type SocketResponse = { status: number; body: unknown };

export type SocketCallOptions = {
  /** Fails the call when no full answer has arrived by then. Unset for calls that last as long as a build. */
  timeoutMs?: number;
};

/** One JSON call over a unix socket: the gateway to the host daemon, or the runner to the gateway. */
export function socketCall(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  options: SocketCallOptions = {},
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (outcome: { response: SocketResponse } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ("response" in outcome) resolve(outcome.response);
      else reject(outcome.error);
    };
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
          settle({ response: { status: response.statusCode ?? 0, body: parsed } });
        });
        response.on("error", (error) => settle({ error }));
      },
    );
    req.on("error", (error) => settle({ error }));
    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs;
      timer = setTimeout(() => {
        settle({ error: new Error(`${method} ${path}: the daemon did not answer within ${timeoutMs} ms`) });
        req.destroy();
      }, timeoutMs);
      timer.unref?.();
    }
    req.end(payload);
  });
}
