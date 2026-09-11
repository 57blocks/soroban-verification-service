import { Injectable } from "@nestjs/common";
import { ScvsLogger } from "@scvs/core";
import type { BuildArchitecture } from "@scvs/core";
import {
  architectureFromConfigDocument,
  architecturesFromManifestDocument,
  configDigestFromManifestDocument,
  parseAuthChallenge,
  parseDigestPinnedImage,
  type ParsedImageReference,
} from "./image-platform.util.js";

/**
 * Establishes which architectures a digest-pinned build image publishes, by asking the registry it is addressed
 * against.
 */

export type ImagePlatformResolution = {
  /** Empty when the registry could not be read, or answered something we cannot route. */
  architectures: BuildArchitecture[];
  resolvedFrom: "index" | "manifest_config" | "unresolved";
};

const UNRESOLVED: ImagePlatformResolution = Object.freeze({
  architectures: [],
  resolvedFrom: "unresolved",
});

/** Both index shapes and both single-manifest shapes, so one request covers every case. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * A digest is immutable, so a cached answer can never be stale — but a hostile stream of distinct references
 * must not grow this without bound.
 */
const CACHE_LIMIT = 512;

@Injectable()
export class ImagePlatformService {
  private readonly logger = new ScvsLogger("image-platform");
  private readonly cache = new Map<string, ImagePlatformResolution>();

  async resolveArchitectures(imageReference: string): Promise<ImagePlatformResolution> {
    const cached = this.cache.get(imageReference);
    if (cached) return cached;

    const parsed = parseDigestPinnedImage(imageReference);
    if (!parsed) {
      // `policy.ts` rejects a non-digest-pinned image long before dispatch, so this is a reference shape we
      // cannot address rather than an untrusted image reaching the sandbox.
      return this.remember(imageReference, UNRESOLVED, "reference is not a digest-pinned image");
    }

    try {
      const resolution = await this.probe(parsed);
      return this.remember(imageReference, resolution);
    } catch (error) {
      return this.remember(
        imageReference,
        UNRESOLVED,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async probe(parsed: ParsedImageReference): Promise<ImagePlatformResolution> {
    const manifest = await this.getJson(parsed, `manifests/${parsed.digest}`, MANIFEST_ACCEPT);

    // An index with one runnable platform is a normal shape, so "is an index" is not "is multi-arch".
    const fromIndex = architecturesFromManifestDocument(manifest);
    if (fromIndex.length > 0) {
      return { architectures: fromIndex, resolvedFrom: "index" };
    }

    const configDigest = configDigestFromManifestDocument(manifest);
    if (!configDigest) return UNRESOLVED;

    const config = await this.getJson(parsed, `blobs/${configDigest}`, "application/json");
    const arch = architectureFromConfigDocument(config);
    return arch ? { architectures: [arch], resolvedFrom: "manifest_config" } : UNRESOLVED;
  }

  /** One `/v2/` GET, following the registry's Bearer challenge once when it answers 401. */
  private async getJson(
    parsed: ParsedImageReference,
    path: string,
    accept: string
  ): Promise<unknown> {
    const url = `https://${parsed.apiHost}/v2/${parsed.repository}/${path}`;

    let response = await this.get(url, accept);
    if (response.status === 401) {
      const token = await this.fetchPullToken(response.headers.get("www-authenticate"), parsed);
      if (!token) throw new Error(`registry requires credentials we do not hold (${parsed.apiHost})`);
      response = await this.get(url, accept, token);
    }
    if (!response.ok) {
      throw new Error(`registry answered ${response.status} for ${path}`);
    }
    return await response.json();
  }

  private get(url: string, accept: string, token?: string): Promise<Response> {
    return fetch(url, {
      headers: {
        accept,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
    });
  }

  private async fetchPullToken(
    challengeHeader: string | null,
    parsed: ParsedImageReference
  ): Promise<string | undefined> {
    const challenge = parseAuthChallenge(challengeHeader);
    if (!challenge) return undefined;

    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    // The challenge's own scope when it gives one; otherwise the narrowest scope that can answer this question.
    tokenUrl.searchParams.set(
      "scope",
      challenge.scope || `repository:${parsed.repository}:pull`
    );

    const response = await this.get(tokenUrl.toString(), "application/json");
    if (!response.ok) return undefined;

    const body = (await response.json()) as { token?: unknown; access_token?: unknown };
    const token = body.token ?? body.access_token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  }

  private remember(
    imageReference: string,
    resolution: ImagePlatformResolution,
    unresolvedDetail?: string
  ): ImagePlatformResolution {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(imageReference, resolution);

    if (resolution.resolvedFrom === "unresolved") {
      // Warn, not error: the dispatch continues on the default architecture.
      this.logger.warn("could not establish the build image's architecture", {
        image: imageReference,
        detail: unresolvedDetail ?? "registry answer carried no routable architecture",
      });
    } else {
      this.logger.log("resolved the build image's architecture", {
        image: imageReference,
        architectures: resolution.architectures,
        resolved_from: resolution.resolvedFrom,
      });
    }
    return resolution;
  }
}
