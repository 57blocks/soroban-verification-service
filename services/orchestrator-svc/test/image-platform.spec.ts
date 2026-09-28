import { ImagePlatformService } from "../src/modules/verification-pipeline/image-platform.service.js";
import { parseDigestPinnedImage } from "../src/modules/verification-pipeline/image-platform.util.js";

const ARM_ONLY_IMAGE =
  "docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43";
const MULTI_ARCH_IMAGE =
  "docker.io/stellar/stellar-cli@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ARM_MANIFEST_IMAGE =
  "docker.io/stellar/stellar-cli@sha256:80a667750133b88ed1a07c82ab80c5863db8f83145c4d98ac741b3e5c7b10841";

const ARM_ONLY_INDEX = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${"a".repeat(64)}`,
      platform: { architecture: "arm64", os: "linux" },
    },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${"b".repeat(64)}`,
      annotations: { "vnd.docker.reference.type": "attestation-manifest" },
      platform: { architecture: "unknown", os: "unknown" },
    },
  ],
};

const MULTI_ARCH_INDEX = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { platform: { architecture: "amd64", os: "linux" } },
    { platform: { architecture: "unknown", os: "unknown" } },
    { platform: { architecture: "arm64", os: "linux" } },
    { platform: { architecture: "amd64", os: "windows" } },
  ],
};

const SINGLE_MANIFEST = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: `sha256:${"c".repeat(64)}`,
  },
};

const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  }) as unknown as Response;

const errorResponse = (status: number, headers: Record<string, string> = {}): Response =>
  ({
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => ({}),
  }) as unknown as Response;

const stubFetch = (
  handler: (url: string) => Response | Promise<Response>
): { calls: string[]; restore: () => void } => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return await handler(url);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
};

describe("parseDigestPinnedImage", () => {
  it("maps Docker Hub's reference name onto its pull API host", () => {
    expect(parseDigestPinnedImage(ARM_ONLY_IMAGE)).toEqual({
      apiHost: "registry-1.docker.io",
      repository: "stellar/stellar-cli",
      digest: ARM_ONLY_IMAGE.split("@")[1],
    });
  });

  it("supplies the implicit library/ namespace for a bare Docker Hub name", () => {
    expect(parseDigestPinnedImage(`docker.io/alpine@sha256:${"a".repeat(64)}`)).toMatchObject({
      repository: "library/alpine",
    });
  });

  it("keeps a non-Docker-Hub registry as its own API host", () => {
    expect(
      parseDigestPinnedImage(`111.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-builder@sha256:${"a".repeat(64)}`)
    ).toMatchObject({
      apiHost: "111.dkr.ecr.ap-southeast-2.amazonaws.com",
      repository: "scvs-builder",
    });
  });

  it("rejects anything that is not host/repo@sha256:<64 hex>", () => {
    for (const reference of [
      "stellar/stellar-cli:latest",
      `stellar-cli@sha256:${"a".repeat(64)}`,
      `docker.io/stellar/stellar-cli@sha256:${"a".repeat(63)}`,
      `docker.io/stellar/stellar-cli@md5:${"a".repeat(32)}`,
      `docker.io/stellar/../../etc@sha256:${"a".repeat(64)}`,
      `docker.io/stellar/cli?x=1@sha256:${"a".repeat(64)}`,
      `docker.io/stellar/cli@sha256:${"a".repeat(64)}/../blobs`,
    ]) {
      expect(parseDigestPinnedImage(reference)).toBeUndefined();
    }
  });
});

describe("ImagePlatformService", () => {
  it("reads an index's platforms and drops attestation manifests", async () => {
    const stub = stubFetch(() => jsonResponse(ARM_ONLY_INDEX));
    try {
      const resolution = await new ImagePlatformService().resolveArchitectures(ARM_ONLY_IMAGE);
      expect(resolution).toEqual({ architectures: ["arm64"], resolvedFrom: "index" });
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it("reports both architectures for a genuinely multi-platform index, linux only", async () => {
    const stub = stubFetch(() => jsonResponse(MULTI_ARCH_INDEX));
    try {
      const resolution = await new ImagePlatformService().resolveArchitectures(MULTI_ARCH_IMAGE);
      expect(resolution.resolvedFrom).toBe("index");
      expect([...resolution.architectures].sort()).toEqual(["amd64", "arm64"]);
    } finally {
      stub.restore();
    }
  });

  it("follows a single manifest to its config blob", async () => {
    const stub = stubFetch((url) =>
      url.includes("/manifests/") ? jsonResponse(SINGLE_MANIFEST) : jsonResponse({ architecture: "arm64", os: "linux" })
    );
    try {
      const resolution = await new ImagePlatformService().resolveArchitectures(ARM_MANIFEST_IMAGE);
      expect(resolution).toEqual({ architectures: ["arm64"], resolvedFrom: "manifest_config" });
      expect(stub.calls[1]).toContain(`/blobs/${SINGLE_MANIFEST.config.digest}`);
    } finally {
      stub.restore();
    }
  });

  it("answers a Bearer challenge once, with pull scope, then retries", async () => {
    const stub = stubFetch((url) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return jsonResponse({ token: "issued-token" });
      }
      return stub.calls.filter((call) => call.includes("/manifests/")).length > 1
        ? jsonResponse(ARM_ONLY_INDEX)
        : errorResponse(401, {
            "www-authenticate":
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          });
    });
    try {
      const resolution = await new ImagePlatformService().resolveArchitectures(ARM_ONLY_IMAGE);
      expect(resolution.architectures).toEqual(["arm64"]);

      const tokenCall = stub.calls.find((call) => call.startsWith("https://auth.docker.io/token"));
      expect(tokenCall).toContain("scope=repository%3Astellar%2Fstellar-cli%3Apull");
      expect(stub.calls).toHaveLength(3);
    } finally {
      stub.restore();
    }
  });

  it("resolves to unresolved — never throws — when the registry fails", async () => {
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ["a 500", () => errorResponse(500)],
      ["a network error", () => Promise.reject(new Error("ECONNREFUSED"))],
      ["a timeout", () => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))],
      ["a 401 with no challenge we can follow", () => errorResponse(401)],
      ["a document with no routable architecture", () => jsonResponse({ manifests: [] })],
    ];

    for (const [label, handler] of cases) {
      const stub = stubFetch(handler);
      try {
        await expect(
          new ImagePlatformService().resolveArchitectures(ARM_ONLY_IMAGE)
        ).resolves.toEqual({ architectures: [], resolvedFrom: "unresolved" });
      } finally {
        stub.restore();
      }
      expect(label).toBeTruthy();
    }
  });

  it("does not reach the network for a reference it cannot address", async () => {
    const stub = stubFetch(() => jsonResponse(ARM_ONLY_INDEX));
    try {
      const resolution = await new ImagePlatformService().resolveArchitectures(
        "stellar/stellar-cli:latest"
      );
      expect(resolution.resolvedFrom).toBe("unresolved");
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it("caches per reference, including a negative answer", async () => {
    const service = new ImagePlatformService();

    const first = stubFetch(() => jsonResponse(ARM_ONLY_INDEX));
    try {
      await service.resolveArchitectures(ARM_ONLY_IMAGE);
    } finally {
      first.restore();
    }

    const second = stubFetch(() => errorResponse(500));
    try {
      await expect(service.resolveArchitectures(ARM_ONLY_IMAGE)).resolves.toEqual({
        architectures: ["arm64"],
        resolvedFrom: "index",
      });
      expect(second.calls).toHaveLength(0);
    } finally {
      second.restore();
    }

    const third = stubFetch(() => errorResponse(500));
    try {
      await service.resolveArchitectures(MULTI_ARCH_IMAGE);
      await service.resolveArchitectures(MULTI_ARCH_IMAGE);
      expect(third.calls).toHaveLength(1);
    } finally {
      third.restore();
    }
  });
});
