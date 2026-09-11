// Stage-1 dependency-prefetch egress policy.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prefetchAllowedHosts } from "./run-cli.config.js";
import type {
  PrefetchEgressPolicy,
  RunCliRuntimeConfig,
} from "./run-cli.types.js";

export async function evaluatePrefetchEgressPolicy(
  sourceRoot: string,
  config?: RunCliRuntimeConfig
): Promise<PrefetchEgressPolicy> {
  const allowedHosts = prefetchAllowedHosts(config);
  const urls = await collectCargoPrefetchUrls(sourceRoot);
  for (const url of urls) {
    const decision = evaluatePrefetchUrl(url, allowedHosts);
    if (!decision.ok) {
      return {
        ok: false,
        allowed_hosts: allowedHosts,
        blocked_url: url,
        detail: decision.reason,
      };
    }
  }
  return { ok: true, allowed_hosts: allowedHosts };
}

export function evaluatePrefetchUrl(
  value: string,
  allowedHosts: string[]
): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(stripSourceSchemePrefix(value));
  } catch {
    return {
      ok: false,
      reason: `Dependency prefetch URL is invalid: ${value}`,
    };
  }

  if (!["https:", "ssh:", "git:"].includes(url.protocol)) {
    return {
      ok: false,
      reason: `Dependency prefetch URL uses a disallowed scheme: ${url.protocol}`,
    };
  }

  const hostname = url.hostname.toLowerCase();
  if (isBlockedPrefetchHost(hostname)) {
    return {
      ok: false,
      reason: `Dependency prefetch URL targets a private, local, or metadata host: ${hostname}`,
    };
  }

  if (!allowedHosts.some((allowed) => hostMatches(hostname, allowed))) {
    return {
      ok: false,
      reason: `Dependency prefetch host is not in the allowlist: ${hostname}`,
    };
  }

  return { ok: true };
}

export async function collectCargoPrefetchUrls(
  sourceRoot: string
): Promise<string[]> {
  const files: string[] = [];
  await collectCargoPolicyFiles(sourceRoot, files);
  const urls = new Set<string>();
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const match of stripTomlComments(text).matchAll(CARGO_SOURCE_KEY)) {
      const value = match[1];
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
        urls.add(value);
      }
    }
  }
  return [...urls];
}

/** The TOML keys whose value cargo actually dereferences over the network. */
const CARGO_SOURCE_KEY =
  /\b(?:git|registry|index|source|replace-with)\s*=\s*["']([^"']+)["']/g;

/**
 * Cargo writes source provenance as `<kind>+<url>` (`registry+https://…`, `git+https://…`, `sparse+https://…`,
 * `git+ssh://…`).
 */
export function stripSourceSchemePrefix(value: string): string {
  return value.replace(/^(?:registry|git|sparse)\+/, "");
}

/** Drop `#` comments, tracking basic and literal strings so a `#` fragment inside a quoted URL survives. */
export function stripTomlComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let quote: string | undefined;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === "\\" && quote === '"') {
            i += 1;
            continue;
          }
          if (ch === quote) quote = undefined;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

export async function collectCargoPolicyFiles(
  dir: string,
  files: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "target", "vendor", "node_modules"].includes(entry.name)) {
        continue;
      }
      await collectCargoPolicyFiles(path, files);
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name === "Cargo.toml" ||
        entry.name === "Cargo.lock" ||
        (entry.name === "config.toml" && path.includes(`${join(".cargo")}`)))
    ) {
      files.push(path);
    }
  }
}

export function hostMatches(hostname: string, allowed: string): boolean {
  const normalized = allowed.toLowerCase();
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

export function isBlockedPrefetchHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal"
  ) {
    return true;
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isBlockedIpv6(hostname.slice(1, -1));
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isBlockedIpv4(hostname);
  }

  return false;
}

export function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function isBlockedIpv6(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return (
    value === "::1" ||
    value.startsWith("fe80:") ||
    value.startsWith("fc") ||
    value.startsWith("fd")
  );
}
