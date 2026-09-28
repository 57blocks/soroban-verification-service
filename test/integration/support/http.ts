import { createHash } from "node:crypto";

import { captureBuildLogToken } from "./build-log-token.js";
import { env } from "./env.js";

export interface HttpResult {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly url: string;
  readonly json?: any;
}

export interface HttpOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly bare?: boolean;
}

export async function http(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? env.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.bare ? options.headers : { accept: "application/json", ...options.headers },
      body: options.body as BodyInit | undefined,
      signal: controller.signal,
      redirect: "follow",
    });

    const buffer = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(buffer);
    const json = tryJson(text);

    // The token is returned only once; capture it here, where no call site can bypass it.
    if (response.status === 202) captureBuildLogToken(json);

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text,
      bytes: buffer,
      durationMs: Date.now() - started,
      url,
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function postJson(url: string, body: unknown, options: HttpOptions = {}) {
  return http(url, {
    ...options,
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(body),
  });
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ErrorEnvelope {
  readonly schema?: string;
  readonly schema_version?: string;
  readonly error: string;
  readonly message: string;
  readonly status_code?: number;
  readonly detail?: string;
  readonly reason?: string;
}

export function expectErrorEnvelope(result: HttpResult): ErrorEnvelope {
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.json).toBeDefined();
  expect(result.json.schema).toBe("stellar-verification-error");
  expect(result.json.schema_version).toBe("1.0");
  expect(typeof result.json.error).toBe("string");
  expect(typeof result.json.message).toBe("string");
  expect(result.json.message.length).toBeGreaterThan(0);
  return result.json as ErrorEnvelope;
}

export function expectStatus(result: HttpResult, ...allowed: number[]): void {
  if (allowed.includes(result.status)) return;
  throw new Error(
    `${result.url} responded ${result.status}, expected ${allowed.join(" or ")}. Body: ${truncate(result.text)}`
  );
}

function truncate(text: string, max = 800): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} bytes total)`;
}

function tryJson(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
