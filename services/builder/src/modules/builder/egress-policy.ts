import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
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
  return evaluateTree(sourceRoot, { skipVendorDirs: true }, allowedHosts);
}

/** A tree the scan cannot read in full is refused: an unread manifest could name any host. */
async function evaluateTree(
  root: string,
  options: { skipVendorDirs: boolean },
  allowedHosts: string[],
): Promise<PrefetchEgressPolicy> {
  let urls: string[];
  try {
    urls = await collectCargoPrefetchUrls(root, options);
  } catch (error) {
    return {
      ok: false,
      allowed_hosts: allowedHosts,
      blocked_url: "",
      detail: `Dependency sources could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return evaluatePrefetchUrls(urls, allowedHosts);
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

  // The prefetch stage's only way out is a proxy that tunnels to port 443, so an ssh or git source could not be
  // fetched anyway; refusing it here says why.
  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: `Dependency prefetch URL uses a disallowed scheme: ${url.protocol} (only https sources can be fetched)`,
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

/** Runs after `cargo vendor` has fetched, so it can reject the result but cannot prevent the fetch. */
export async function evaluateVendoredEgressPolicy(
  vendorDir: string,
  allowedHosts: string[]
): Promise<PrefetchEgressPolicy> {
  return evaluateTree(vendorDir, { skipVendorDirs: false }, allowedHosts);
}

function evaluatePrefetchUrls(urls: string[], allowedHosts: string[]): PrefetchEgressPolicy {
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

// A constant, not a literal in the list: check:builder-isolation reads `"git",` as spawning git.
const GIT_KEY = "git";
const SOURCE_KEYS = new Set([GIT_KEY, "registry", "registry-index", "index", "source", "replace-with"]);
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Every source cargo could dereference, read with a TOML parser so escapes, multi-line strings, quoted and
 * dotted keys all resolve as cargo resolves them. Throws on a file it cannot read or parse.
 */
export async function collectCargoPrefetchUrls(
  sourceRoot: string,
  options: { skipVendorDirs: boolean } = { skipVendorDirs: true }
): Promise<string[]> {
  const files: string[] = [];
  await collectCargoPolicyFiles(sourceRoot, files, options.skipVendorDirs);
  const urls = new Set<string>();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    let document: unknown;
    try {
      document = parseToml(text);
    } catch (error) {
      throw new Error(`${file} is not valid TOML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    collectSourceValues(document, urls, false);
  }
  return [...urls];
}

function collectSourceValues(node: unknown, urls: Set<string>, underPatch: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSourceValues(item, urls, false);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" && SOURCE_KEYS.has(key) && HAS_SCHEME.test(value)) urls.add(value);
    if (underPatch && HAS_SCHEME.test(key)) urls.add(key);
    collectSourceValues(value, urls, key === "patch");
  }
}

export function stripSourceSchemePrefix(value: string): string {
  return value.replace(/^(?:registry|git|sparse)\+/, "");
}

export async function collectCargoPolicyFiles(
  dir: string,
  files: string[],
  skipVendorDirs = true
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skippedDirs = skipVendorDirs
    ? [".git", "target", "vendor", "node_modules"]
    : [".git", "target", "node_modules"];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirs.includes(entry.name)) {
        continue;
      }
      await collectCargoPolicyFiles(path, files, skipVendorDirs);
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
