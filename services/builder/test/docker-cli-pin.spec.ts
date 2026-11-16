import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docker", "builder.Dockerfile");

describe("the builder image's docker CLI", () => {
  const text = readFileSync(DOCKERFILE, "utf8");

  it("is not Debian's docker.io, whose 20.10 CLI rejects bind-recursive=disabled", () => {
    const installs = text.match(/apt-get install[^\n]*(?:\\\n[^\n]*)*/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) expect(install).not.toMatch(/\bdocker\.io\b/);
  });

  it("is a pinned release of Docker 25 or later, checked by sha256 for both architectures", () => {
    const version = /ARG DOCKER_CLI_VERSION=(\d+)\.(\d+)\.(\d+)/.exec(text);
    expect(version).not.toBeNull();
    expect(Number(version![1])).toBeGreaterThanOrEqual(25);
    expect(text).toMatch(/arm64\) arch=aarch64; sha256=[0-9a-f]{64} ;;/);
    expect(text).toMatch(/amd64\) arch=x86_64; sha256=[0-9a-f]{64} ;;/);
    expect(text).toContain('sha256sum -c -');
    expect(text).toContain("COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker");
  });
});
