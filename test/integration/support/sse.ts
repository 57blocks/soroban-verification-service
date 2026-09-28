import { env } from "./env.js";
import { jobEventsUrl } from "./routes.js";
import { TERMINAL_JOB_STATUSES, type JobStatusBody } from "./types.js";

export interface SseFrame {
  readonly data: JobStatusBody | Record<string, unknown>;
  readonly receivedAt: number;
}

export interface SseSession {
  readonly frames: SseFrame[];
  readonly closed: Promise<"server_closed" | "client_closed">;
  stop(): void;
}

export interface SseOptions {
  readonly until?: (frame: SseFrame, all: SseFrame[]) => boolean;
  readonly timeoutMs?: number;
}

export function openJobStream(jobId: string, options: SseOptions = {}): SseSession {
  const controller = new AbortController();
  const frames: SseFrame[] = [];
  let stoppedByClient = false;

  const timeoutMs = options.timeoutMs ?? env.jobTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const closed = (async (): Promise<"server_closed" | "client_closed"> => {
    try {
      const response = await fetch(jobEventsUrl(jobId), {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(
          `SSE connect to ${jobEventsUrl(jobId)} failed: ${response.status} ${response.statusText}`
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames end at a blank line; tolerate CRLF, which some proxies emit.
        let boundary = /\r?\n\r?\n/.exec(buffer);
        while (boundary) {
          const raw = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);

          const parsed = parseFrame(raw);
          if (parsed) {
            const frame = { data: parsed, receivedAt: Date.now() };
            frames.push(frame);
            if (options.until?.(frame, frames)) {
              stoppedByClient = true;
              controller.abort();
              return "client_closed";
            }
          }
          boundary = /\r?\n\r?\n/.exec(buffer);
        }
      }
      return "server_closed";
    } catch (error) {
      if (stoppedByClient || controller.signal.aborted) {
        return stoppedByClient ? "client_closed" : "server_closed";
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();

  return {
    frames,
    closed,
    stop() {
      stoppedByClient = true;
      controller.abort();
    },
  };
}

export async function readJobStreamToClose(
  jobId: string,
  options: SseOptions = {}
): Promise<SseFrame[]> {
  const session = openJobStream(jobId, options);
  await session.closed;
  return session.frames;
}

export function isTerminalFrame(frame: SseFrame): boolean {
  const status = (frame.data as JobStatusBody).status;
  return typeof status === "string" && TERMINAL_JOB_STATUSES.includes(status as never);
}

function parseFrame(raw: string): Record<string, unknown> | undefined {
  const payload = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!payload) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return { unparsed: payload };
  }
}
