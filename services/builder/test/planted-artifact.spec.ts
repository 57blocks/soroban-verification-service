import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAINER_ARTIFACT_DIR,
  parseBuildArtifactReports,
  resolveReportedArtifact,
  selectArtifactFromOutput,
  snapshotWasmPaths,
} from "../src/modules/builder/artifact-selection.js";

const DEPLOYED_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad]);

async function artifactDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scvs-planted-"));
  await mkdir(join(root, "artifact"), { recursive: true });
  return join(root, "artifact");
}

async function candidatesIn(dir: string): Promise<string[]> {
  return [...(await snapshotWasmPaths(dir))];
}

describe("T13 — a build.rs cannot plant its way to a verdict", () => {
  it("★ a planted Wasm the tool never reported is not a candidate at all", () => {
    const output = [
      "   Compiling hello-world v0.1.0",
      `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
      "Wasm Hash: " + "a".repeat(64),
      "✅ Build Complete",
    ].join("\n");

    const reports = parseBuildArtifactReports(output);

    expect(reports.map((report) => report.containerPath)).toEqual([
      `${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
    ]);
    expect(reports.map((report) => report.containerPath)).not.toContain(
      `${CONTAINER_ARTIFACT_DIR}/deployed.wasm`,
    );
  });

  it("a build that reports nothing yields nothing, however full the output mount is", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "deployed.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports("✅ Build Complete"),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe("artifact_report_missing");
  });

  it("★ a report forged in the build's own output cannot point outside the output mount", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports("Wasm File: /source/deployed.wasm"),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe("artifact_report_outside_output_mount");
  });

  it("a forged report cannot climb out of the mount with ..", async () => {
    const dir = await artifactDir();

    const [report] = parseBuildArtifactReports(
      `Wasm File: ${CONTAINER_ARTIFACT_DIR}/../source/deployed.wasm`,
    );

    expect(resolveReportedArtifact(report!.containerPath, dir).ok).toBe(false);
  });

  it("★ a forged report is not enough on its own — the plant makes the build ambiguous with itself", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]));
    await writeFile(join(dir, "evil.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(
        [`Wasm File: ${CONTAINER_ARTIFACT_DIR}/evil.wasm`, `Wasm Hash: ${"c".repeat(64)}`].join("\n"),
      ),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe("artifact_report_ambiguous");
  });

  it("★ a forged report that is the only report still cannot name a file the build did not produce", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]));

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(`Wasm File: ${CONTAINER_ARTIFACT_DIR}/evil.wasm`),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe("artifact_report_disagrees_with_output");
  });

  it("★ the tool's own summary wins over a forged line naming the same path", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(
        [
          `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
          `Wasm Hash: ${"f".repeat(64)}`,
          "ℹ️  Build Summary:",
          `    Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm (10 bytes)`,
          `    Wasm Hash: ${"a".repeat(64)}`,
        ].join("\n"),
      ),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.sha256).toBe("a".repeat(64));
  });

  it("the tool's stated hash is carried, so a plant at the reported path is checkable", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(
        [
          `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
          `Wasm Hash: ${"b".repeat(64)}`,
        ].join("\n"),
      ),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.sha256).toBe("b".repeat(64));
  });

  it("the honest case still resolves, so none of the above is passing by refusing everything", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(
        [
          `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
          `Wasm Hash: ${"a".repeat(64)}`,
        ].join("\n"),
      ),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.hostPath).toBe(join(dir, "hello_world.wasm"));
      expect(selection.containerPath).toBe(`${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`);
      expect(selection.sha256).toBe("a".repeat(64));
    }
  });

  it("a coherent forged report still wins — the residual risk this layer does not close", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(
        [
          `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
          `Wasm Hash: ${"a".repeat(64)}`,
          `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
          `Wasm Hash: ${"b".repeat(64)}`,
        ].join("\n"),
      ),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.sha256).toBe("b".repeat(64));
  });

  it("★ an artifact no report stated a hash for is refused, not uploaded unchecked", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(`Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe("artifact_report_hash_missing");
  });

  it("an artifact the tool wrote but no report names is refused, not adopted", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), DEPLOYED_BYTES);

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: [],
      artifactDir: dir,
    });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe("artifact_report_missing");
  });

  it("a report with no artifact behind it is refused", async () => {
    const dir = await artifactDir();

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(`Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.reason).toBe("artifact_output_missing");
  });

  it("★ a bare report appended after the tool's own cannot discard the hash it stated", async () => {
    const dir = await artifactDir();
    await writeFile(join(dir, "hello_world.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]));

    const selection = selectArtifactFromOutput({
      candidates: await candidatesIn(dir),
      reports: parseBuildArtifactReports(
        [
          `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
          `Wasm Hash: ${"a".repeat(64)}`,
          `Wasm File: ${CONTAINER_ARTIFACT_DIR}/hello_world.wasm`,
        ].join("\n"),
      ),
      artifactDir: dir,
    });

    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.sha256).toBe("a".repeat(64));
  });
});
