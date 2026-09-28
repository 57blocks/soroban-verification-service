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

export type ImagePlatformResolution = {
  architectures: BuildArchitecture[];
  resolvedFrom: "index" | "manifest_config" | "unresolved";
};

const UNRESOLVED: ImagePlatformResolution = Object.freeze({
  architectures: [],
  resolvedFrom: "unresolved",
});

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const REQUEST_TIMEOUT_MS = 5_000;

// Digest answers never go stale; the bound caps growth from a stream of distinct references.
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
