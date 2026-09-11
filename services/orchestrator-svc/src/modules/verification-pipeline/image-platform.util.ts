import type { BuildArchitecture } from "@scvs/core";

/**
 * Pure readers for the two things a container registry can tell us about a digest-pinned image: how to address
 * it, and which architectures it publishes.
 */

/** Docker Hub's pull API is served from this host, not from the name that appears in a reference. */
const DOCKER_HUB_API_HOST = "registry-1.docker.io";
const DOCKER_HUB_NAMES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const HOST_RE = /^(?:localhost(?::\d+)?|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)$/i;
const PATH_SEGMENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

/**
 * Architecture tokens seen in the wild for the two we run. OCI writes `arm64`/`amd64`; `uname -m` spellings
 * turn up in hand-written manifests, so both map rather than resolving to "unknown".
 */
const ARCH_ALIASES: Record<string, BuildArchitecture> = {
  arm64: "arm64",
  aarch64: "arm64",
  amd64: "amd64",
  x86_64: "amd64",
};

export type ParsedImageReference = {
  /** The registry API host to send `/v2/...` requests to. */
  apiHost: string;
  /** The repository path as the API expects it — a bare Docker Hub name gains its `library/`. */
  repository: string;
  digest: string;
};

/**
 * Splits `host/repo@sha256:<64 hex>` into the pieces a registry request needs, or returns `undefined` when the
 * reference is not exactly that.
 */
export function parseDigestPinnedImage(reference: string): ParsedImageReference | undefined {
  const at = reference.indexOf("@");
  if (at <= 0) return undefined;

  const name = reference.slice(0, at);
  const digest = reference.slice(at + 1);
  if (!DIGEST_RE.test(digest)) return undefined;

  const segments = name.split("/");
  // An explicit registry host is required: without one, `repo/name` is ambiguous (Docker's own defaulting
  // rules), and guessing which half is a host is how a URL gets built out of a path.
  if (segments.length < 2) return undefined;

  const [host, ...pathSegments] = segments;
  if (!host || !HOST_RE.test(host)) return undefined;
  if (!pathSegments.every((segment) => PATH_SEGMENT_RE.test(segment))) return undefined;

  const isDockerHub = DOCKER_HUB_NAMES.has(host.toLowerCase());
  const repository =
    isDockerHub && pathSegments.length === 1
      ? `library/${pathSegments[0]}`
      : pathSegments.join("/");

  return {
    apiHost: isDockerHub ? DOCKER_HUB_API_HOST : host,
    repository,
    digest,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const toBuildArch = (value: unknown): BuildArchitecture | undefined =>
  typeof value === "string" ? ARCH_ALIASES[value.toLowerCase()] : undefined;

/**
 * The architectures an image *index* (OCI index / Docker manifest list) publishes, deduplicated and in the
 * order they appear.
 */
export function architecturesFromManifestDocument(document: unknown): BuildArchitecture[] {
  const manifests = asRecord(document)?.manifests;
  if (!Array.isArray(manifests)) return [];

  const found: BuildArchitecture[] = [];
  for (const entry of manifests) {
    const platform = asRecord(asRecord(entry)?.platform);
    if (!platform) continue;
    if (typeof platform.os === "string" && platform.os.toLowerCase() !== "linux") continue;
    const arch = toBuildArch(platform.architecture);
    if (arch && !found.includes(arch)) found.push(arch);
  }
  return found;
}

/** The `architecture` an image config blob states, for a digest that addresses one manifest. */
export function architectureFromConfigDocument(document: unknown): BuildArchitecture | undefined {
  const record = asRecord(document);
  if (!record) return undefined;
  if (typeof record.os === "string" && record.os.toLowerCase() !== "linux") return undefined;
  return toBuildArch(record.architecture);
}

/** The config blob digest a single-manifest document points at, when it is one. */
export function configDigestFromManifestDocument(document: unknown): string | undefined {
  const digest = asRecord(asRecord(document)?.config)?.digest;
  return typeof digest === "string" && DIGEST_RE.test(digest) ? digest : undefined;
}

export type AuthChallenge = { realm: string; service?: string; scope?: string };

/** Reads a registry's `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge. */
export function parseAuthChallenge(header: string | null | undefined): AuthChallenge | undefined {
  if (!header || !/^bearer\s/i.test(header)) return undefined;

  const parameters = new Map<string, string>();
  for (const [, key, value] of header.matchAll(/([a-z_]+)="([^"]*)"/gi)) {
    parameters.set(key.toLowerCase(), value);
  }

  const realm = parameters.get("realm");
  if (!realm || !/^https:\/\//i.test(realm)) return undefined;

  const service = parameters.get("service");
  const scope = parameters.get("scope");
  return { realm, ...(service ? { service } : {}), ...(scope ? { scope } : {}) };
}
