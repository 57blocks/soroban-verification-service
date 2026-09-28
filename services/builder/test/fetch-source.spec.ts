import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeSource } from "../src/modules/builder/fetch-source.js";

describe("materializeSource — refused source shapes", () => {
  it.each(["git", "hosted_tarball"] as const)(
    "refuses a %s source ref rather than acquiring it itself",
    async (type) => {
      const result = await materializeSource({
        sourceRef: { type, visibility: "public", repo: "https://example.com/x.git", rev: "HEAD" } as never,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe("source_unavailable");
        expect(result.reason).toBe("source_ref_unsupported");
      }
    },
  );

  it("refuses a git ref naming a readable local directory, which the old arm accepted", async () => {
    const repo = await gitFixture();

    const result = await materializeSource({
      sourceRef: { type: "git", visibility: "public", repo, rev: "HEAD" } as never,
    });

    expect(result.ok).toBe(false);
  });
});

describe("materializeSource — source_sha256 provenance", () => {
  it("publishes the hash it computed for an archive, and rejects a mismatch", async () => {
    const { path, sha256 } = await archiveFixture();

    const ok = await materializeSource({
      sourceRef: {
        type: "source_uri",
        visibility: "public",
        source_uri: path,
        source_sha256: sha256.toUpperCase(),
      } as never,
    });

    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.source.source_sha256).toBe(sha256);

    const mismatch = await materializeSource({
      sourceRef: {
        type: "source_uri",
        visibility: "public",
        source_uri: path,
        source_sha256: "b".repeat(64),
      } as never,
    });

    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.status).toBe("source_hash_mismatch");
      expect(mismatch.reason).toBe("source_sha256_mismatch");
    }
  });
});

async function archiveFixture(): Promise<{ path: string; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "scvs-fetch-src-"));
  const path = join(root, "source.tar");
  await writeFile(path, "not really a tar, but these are the bytes we hash\n");
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { path, sha256 };
}

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scvs-fetch-git-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "Cargo.toml"), "[package]\nname = \"pkg\"\n");
  return repo;
}
