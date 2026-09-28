import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { referenceAlignment } from "../../src/modules/builder/reference-alignment.js";
import { CONTAINER_OUT_DIR, parseBuildArtifactReports } from "../../src/modules/builder/artifact-selection.js";
import { dockerEnvOptions, extractBuildPackage, leadingBuildArgs, replayableBuildOptions } from "../../src/modules/builder/build-options.js";
import { runCommand, sha256File } from "@scvs/core/process";
import { runCli } from "../../src/modules/builder/run-cli.js";
import { unescapeShellWord } from "@scvs/core";
import type { Deviation, DifferentialFixture } from "./fixtures.js";

export type DifferentialFixtureResult = {
  matched: boolean;
  rules: string[];
  sha256?: string;
  error?: string;
};

export async function runDifferentialFixture(fixture: DifferentialFixture): Promise<DifferentialFixtureResult> {
  const referenceHash = await runReferenceLeg(fixture);
  const sandboxHash = await runSandboxLeg(fixture);
  const deviationHashes = await Promise.all(
    fixture.deviationsUnderTest.map(async (deviation) => [deviation, await runDeviationOffLeg(fixture, deviation)] as const),
  );
  const matched = referenceHash === sandboxHash && deviationHashes.every(([, hash]) => hash === sandboxHash);
  if (matched) await recordHostResult(fixture.id, sandboxHash);
  return {
    matched,
    rules: fixture.rules,
    ...(matched
      ? { sha256: sandboxHash }
      : { error: mismatchSummary(referenceHash, sandboxHash, deviationHashes) }),
  };
}

function pickReportedArtifact(
  reports: { containerPath: string; sha256?: string }[],
  packageName?: string,
): { containerPath: string; sha256?: string } {
  if (reports.length === 0) throw new Error("The build tool printed no artifact report.");
  if (reports.length === 1) return reports[0];
  if (packageName) {
    const wanted = `${packageName.replace(/-/g, "_")}.wasm`;
    const matches = reports.filter((report) => report.containerPath.endsWith(`/${wanted}`));
    if (matches.length === 1) return matches[0];
  }
  throw new Error(
    `The build tool reported ${reports.length} artifacts and none could be matched to the requested package.`,
  );
}

async function runReferenceLeg(fixture: DifferentialFixture): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scvs-diff-ref-"));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  const copy = await runCommand(["cp", "-R", `${fixture.sourceDir}/.`, source], { mirrorOutput: false });
  if (copy.exit_code !== 0) throw new Error(copy.stderr || copy.error || "Could not stage reference fixture source.");
  await openTempTreeToContainerUser(root);

  const command = referenceBuildCommand(fixture, source);
  const result = await runCommand(command, { timeout_ms: 15 * 60_000 });
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || result.error || "Reference build failed.");
  }

  const reports = parseBuildArtifactReports(`${result.stdout}\n${result.stderr}`);
  const selected = pickReportedArtifact(reports, extractBuildPackage(fixture.bldopt));
  const artifactPath = resolveReferenceArtifactPath(source, selected.containerPath);
  return sha256File(artifactPath);
}

function referenceBuildCommand(fixture: DifferentialFixture, source: string): string[] {
  const replayed = replayableBuildOptions(fixture.bldopt);
  if (replayed.unparsable.length) {
    throw new Error(`Unparsable fixture bldopt: ${JSON.stringify(replayed.unparsable)}`);
  }
  const manifestPath = extractManifestPath(fixture.bldopt);
  const buildPackage = extractBuildPackage(fixture.bldopt);
  const recorded = [
    ...replayed.forwarded,
    "--manifest-path",
    manifestPath === "." ? "Cargo.toml" : manifestPath,
    ...(buildPackage ? ["--package", buildPackage] : []),
  ];
  return [
    "docker",
    "run",
    "--rm",
    "-v",
    `${source}:/source`,
    "-w",
    "/source",
    ...dockerEnvOptions(fixture.bldopt).flatMap((entry) => ["-e", entry]),
    fixture.image,
    ...leadingBuildArgs(fixture.bldarg),
    ...recorded,
  ];
}

async function runSandboxLeg(fixture: DifferentialFixture): Promise<string> {
  const manifestPath = extractManifestPath(fixture.bldopt);
  const result = await runCli({
    mode: "build",
    target: { network: "testnet", wasm_hash: "0".repeat(64) },
    build: {
      image: fixture.image,
      workspace_path: manifestPath,
      package: extractBuildPackage(fixture.bldopt),
      target: "wasm32v1-none",
      bldarg: fixture.bldarg,
      bldopt: fixture.bldopt,
    },
    source: {
      mode: "public_repo",
      visibility: "public",
      source_sha256: "fixture",
      // `runManualRebuild` resolves the source root from `workspace_path`, so it must be the absolute source dir.
      workspace_path: fixture.sourceDir,
      local_path: fixture.sourceDir,
      retained_after_verification: false,
    },
  });
  if (result.outcome !== "built" || !result.rebuilt_wasm_hash) {
    throw new Error(result.reason || JSON.stringify(result.diagnostics));
  }
  return result.rebuilt_wasm_hash;
}

async function runDeviationOffLeg(fixture: DifferentialFixture, deviation: Deviation): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `scvs-diff-${deviation}-`));
  const source = join(root, "source");
  const out = join(root, "out");
  const vendor = join(out, "vendor");
  await mkdir(source, { recursive: true });
  await mkdir(join(out, "tmp"), { recursive: true });
  await mkdir(vendor, { recursive: true });
  const copy = await runCommand(["cp", "-R", `${fixture.sourceDir}/.`, source], { mirrorOutput: false });
  if (copy.exit_code !== 0) throw new Error(copy.stderr || copy.error || "Could not stage deviation fixture source.");
  await openTempTreeToContainerUser(root);

  const manifestPath = extractManifestPath(fixture.bldopt);
  const containerManifestPath = manifestPath === "." ? "/source/Cargo.toml" : `/source/${manifestPath}`;
  const replayed = replayableBuildOptions(fixture.bldopt);
  if (replayed.unparsable.length) {
    throw new Error(`Unparsable fixture bldopt: ${JSON.stringify(replayed.unparsable)}`);
  }

  const vendoredOffline = deviation !== "vendored-offline";
  if (vendoredOffline) {
    const prefetch = await runCommand(
      [
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "cargo",
        "-v",
        `${source}:/source:ro`,
        "-v",
        `${vendor}:/vendor`,
        "-v",
        `${out}:${CONTAINER_OUT_DIR}`,
        "-w",
        "/source",
        "-e",
        `CARGO_HOME=${CONTAINER_OUT_DIR}/cargo-home`,
        fixture.image,
        "vendor",
        "--locked",
        "--manifest-path",
        containerManifestPath,
        "/vendor",
      ],
      { timeout_ms: 15 * 60_000 },
    );
    if (prefetch.exit_code !== 0) {
      throw new Error(prefetch.stderr || prefetch.stdout || prefetch.error || "Deviation prefetch failed.");
    }
  }

  const env = deviationEnv(fixture, deviation, vendoredOffline);
  const command = [
    "docker",
    "run",
    "--rm",
    ...(vendoredOffline ? ["--network", "none"] : []),
    "-v",
    `${source}:/source${deviation === "readonly-source-mount" || deviation === "redirected-target-dir" ? "" : ":ro"}`,
    ...(vendoredOffline ? ["-v", `${vendor}:/vendor:ro`] : []),
    "-v",
    `${out}:${CONTAINER_OUT_DIR}`,
    "-w",
    "/source",
    ...env.flatMap((entry) => ["-e", entry]),
    fixture.image,
    ...leadingBuildArgs(fixture.bldarg),
    ...replayed.forwarded,
    "--manifest-path",
    containerManifestPath,
    ...(extractBuildPackage(fixture.bldopt) ? ["--package", extractBuildPackage(fixture.bldopt)!] : []),
    "--out-dir",
    CONTAINER_OUT_DIR,
  ];
  const build = await runCommand(command, { timeout_ms: 15 * 60_000 });
  if (build.exit_code !== 0) {
    throw new Error(build.stderr || build.stdout || build.error || `Deviation ${deviation} build failed.`);
  }

  const reports = parseBuildArtifactReports(`${build.stdout}\n${build.stderr}`);
  const selected = pickReportedArtifact(reports, extractBuildPackage(fixture.bldopt));
  if (!selected.containerPath.startsWith(`${CONTAINER_OUT_DIR}/`)) {
    throw new Error(`Deviation build reported artifact outside ${CONTAINER_OUT_DIR}: ${selected.containerPath}`);
  }
  return sha256File(join(out, selected.containerPath.slice(CONTAINER_OUT_DIR.length + 1)));
}

/** Oracle images run as non-root and bind mounts keep host ownership; `--user` would instead break the image's CARGO_HOME. */
async function openTempTreeToContainerUser(root: string): Promise<void> {
  const relaxed = await runCommand(["chmod", "-R", "a+rwX", root], { mirrorOutput: false });
  if (relaxed.exit_code !== 0) {
    throw new Error(relaxed.stderr || relaxed.error || `Could not open ${root} to the container user.`);
  }
}

function deviationEnv(fixture: DifferentialFixture, deviation: Deviation, vendoredOffline: boolean): string[] {
  return [
    ...(deviation === "redirected-target-dir" ? [] : [`CARGO_TARGET_DIR=${CONTAINER_OUT_DIR}/target`]),
    `TMPDIR=${CONTAINER_OUT_DIR}/tmp`,
    ...(vendoredOffline
      ? [`CARGO_HOME=${CONTAINER_OUT_DIR}/cargo-home`, "CARGO_NET_OFFLINE=true"]
      : []),
    ...dockerEnvOptions(fixture.bldopt),
  ];
}

function extractManifestPath(bldopt: string[]): string {
  const tokens: string[] = [];
  for (const entry of bldopt) {
    const parsed = unescapeShellWord(entry);
    if (parsed.ok) tokens.push(parsed.word);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--manifest-path" && tokens[index + 1]) return tokens[index + 1];
    const inline = token.match(/^--manifest-path=(.+)$/);
    if (inline) return inline[1];
  }
  return ".";
}

function mismatchSummary(
  referenceHash: string,
  sandboxHash: string,
  deviationHashes: readonly (readonly [Deviation, string])[],
): string {
  return [
    `reference=${referenceHash}`,
    `sandbox=${sandboxHash}`,
    ...deviationHashes.map(([deviation, hash]) => `${deviation}=${hash}`),
  ].join(" ");
}

function resolveReferenceArtifactPath(sourceRoot: string, containerPath: string): string {
  if (containerPath.startsWith("/source/")) return join(sourceRoot, containerPath.slice("/source/".length));
  if (!containerPath.startsWith("/")) return join(sourceRoot, containerPath);
  throw new Error(`Reference build reported an artifact outside the source mount: ${containerPath}.`);
}

async function recordHostResult(fixtureId: string, sha256: string): Promise<void> {
  const hostLabel = process.env.SCVS_DIFFERENTIAL_HOST_LABEL;
  if (!hostLabel) return;
  const resultsDir = join(repoRoot(), "test", "differential", "results");
  await mkdir(resultsDir, { recursive: true });
  const path = join(resultsDir, `${hostLabel}.json`);
  const current = existsSync(path)
    ? JSON.parse(await readFile(path, "utf8")) as { host_label: string; fixtures: Record<string, unknown> }
    : { host_label: hostLabel, fixtures: {} };
  current.fixtures[fixtureId] = { sha256, reference_alignment: referenceAlignment() };
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
}

function repoRoot(): string {
  let current = resolve(process.cwd());
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to locate repository root");
    current = parent;
  }
}
