import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/modules/builder/run-cli.js";
import { requireExtractedSourceRoot } from "../src/modules/builder/sandbox-runtime.js";
import type { MaterializedSource } from "../src/modules/builder/fetch-source.js";

/** Which field of the handoff the build-mode rebuild treats as its source root. */

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;

/** A handoff exactly as the materialiser publishes one for an archive source: extracted dir + archive. */
async function archiveHandoff(): Promise<{ source: MaterializedSource; extractedRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "scvs-handoff-"));
  const extractedRoot = join(root, "extracted");
  await mkdir(extractedRoot, { recursive: true });
  await writeFile(join(extractedRoot, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.0.0"\n');

  const archivePath = join(root, "source.tar.gz");
  await writeFile(archivePath, "not a real archive, and never read: the runner must not unpack it");

  return {
    extractedRoot,
    source: {
      mode: "hosted_tarball",
      visibility: "public",
      source_uri: "https://example.com/source.tar.gz",
      source_sha256: "b".repeat(64),
      // What the materialiser guarantees is a directory (`extractIfArchive`).
      workspace_path: extractedRoot,
      local_path: archivePath,
      retained_after_verification: false,
    },
  };
}

describe("requireExtractedSourceRoot", () => {
  it("accepts a directory and refuses an archive, which is the CE1 boundary it enforces", async () => {
    const { source, extractedRoot } = await archiveHandoff();

    await expect(requireExtractedSourceRoot(extractedRoot)).resolves.toMatchObject({
      ok: true,
      source_root: extractedRoot,
    });
    await expect(requireExtractedSourceRoot(source.local_path!)).resolves.toMatchObject({
      ok: false,
      reason: "source_not_extracted",
    });
  });

  it("names a vanished path distinctly from an unextracted one", async () => {
    await expect(requireExtractedSourceRoot(join(tmpdir(), "scvs-does-not-exist-", String(Date.now())))).resolves.toMatchObject({
      ok: false,
      reason: "source_path_not_found",
    });
  });
});

describe("build-mode rebuild source root", () => {
  it("uses the extracted tree from the handoff, not the archive beside it", async () => {
    // With `local_path` read here, this returned `source_not_extracted` — before touching Docker, before
    // looking for a manifest.
    const { source } = await archiveHandoff();

    const result = await runCli({
      mode: "build",
      target: { network: "testnet", contract_id: `C${"A".repeat(55)}` },
      build: { image: IMAGE, workspace_path: source.workspace_path, target: "wasm32v1-none", bldarg: [], bldopt: [] },
      source,
      config: { cliTimeoutMs: 5_000 },
    });

    expect(result.diagnostics?.reason).not.toBe("source_not_extracted");
    expect(result.diagnostics?.reason).not.toBe("source_path_not_found");
    expect(result.diagnostics?.reason).not.toBe("source_not_local_for_fallback");
  });

  it("still refuses when the handoff carries no materialized path at all", async () => {
    // The guard is kept even though `workspace_path` is required on `MaterializedSource`: a malformed handoff
    // carrying an empty string must fail with a named reason rather than resolving "" to cwd.
    const { source } = await archiveHandoff();

    const result = await runCli({
      mode: "build",
      target: { network: "testnet", contract_id: `C${"A".repeat(55)}` },
      build: { image: IMAGE, workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt: [] },
      source: { ...source, workspace_path: "" },
      config: { cliTimeoutMs: 5_000 },
    });

    expect(result.diagnostics?.reason).toBe("source_not_local_for_fallback");
  });

  it("does not fall back to local_path when the extracted tree is gone", async () => {
    // Belt and braces on the field choice: if `workspace_path` is unusable the rebuild must say so, not quietly
    // reach for the archive and re-derive the bug in a new place.
    const { source } = await archiveHandoff();

    const result = await runCli({
      mode: "build",
      target: { network: "testnet", contract_id: `C${"A".repeat(55)}` },
      build: { image: IMAGE, workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt: [] },
      source: { ...source, workspace_path: join(tmpdir(), `scvs-gone-${Date.now()}`) },
      config: { cliTimeoutMs: 5_000 },
    });

    expect(result.diagnostics?.reason).toBe("source_path_not_found");
  });
});
