import type { RebuildErrorCode } from "@scvs/core";

import { readdir, rm, stat } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";
import type { CommandResult } from "@scvs/core/process";

/** Compiler-visible path: changing it changes the built bytes. */
export const CONTAINER_OUT_DIR = "/out";

export const CONTAINER_ARTIFACT_DIR = "/artifact";

export type BuildArtifactReport = {
  containerPath: string;
  sha256?: string;
};

export function parseBuildArtifactReports(output: string): BuildArtifactReport[] {
  const reports: BuildArtifactReport[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Non-greedy up to `.wasm` so a trailing ` (1234 bytes …)` size annotation is not swallowed into the path.
    const file = line.match(/^Wasm File:\s*(\S.*?\.wasm)(?:\s*\(.*\))?$/);
    if (file) {
      reports.push({ containerPath: file[1].trim() });
      continue;
    }

    const hash = line.match(/^Wasm Hash:\s*([0-9a-f]{64})$/i);
    if (hash && reports.length) {
      const current = reports[reports.length - 1];
      if (!current.sha256) current.sha256 = hash[1].toLowerCase();
    }
  }
  return reports;
}

/** A report only confirms the sole artifact in the mount, never selects one: code run by the compile can print a report. */
export function selectArtifactFromOutput(input: {
  candidates: string[];
  reports: BuildArtifactReport[];
  artifactDir: string;
}):
  | { ok: true; hostPath: string; containerPath: string; sha256: string }
  | { ok: false; reason: RebuildErrorCode; detail: string } {
  if (input.reports.length === 0) {
    return {
      ok: false,
      reason: "artifact_report_missing",
      detail:
        "The build tool printed no artifact report, so the rebuilt Wasm cannot be identified. " +
        "Selecting a file by scanning the output directory is not an acceptable fallback (AR1).",
    };
  }
  if (input.candidates.length === 0) {
    return {
      ok: false,
      reason: "artifact_output_missing",
      detail:
        `The build tool reported an artifact but wrote no .wasm to ${CONTAINER_ARTIFACT_DIR}, ` +
        "so there is nothing its report can be confirmed against.",
    };
  }
  if (input.candidates.length > 1) {
    return {
      ok: false,
      reason: "artifact_report_ambiguous",
      detail:
        `The build wrote ${input.candidates.length} .wasm files to ${CONTAINER_ARTIFACT_DIR}. ` +
        "Refusing to guess which one is the rebuild.",
    };
  }

  const candidate = input.candidates[0];
  let outsideMount: { reason: RebuildErrorCode; detail: string } | undefined;
  // Reverse order: the tool prints its own summary last, after anything the compile emitted.
  for (let index = input.reports.length - 1; index >= 0; index -= 1) {
    const report = input.reports[index];
    const resolved = resolveReportedArtifact(report.containerPath, input.artifactDir);
    if (!resolved.ok) {
      outsideMount ??= { reason: resolved.reason, detail: resolved.detail };
      continue;
    }
    if (resolved.hostPath !== candidate) continue;

    const sha256 = report.sha256 ?? lastHashFor(input.reports.slice(0, index), candidate, input.artifactDir);
    if (!sha256) {
      // A missing hash must refuse; treating it as a skip would fail open.
      return {
        ok: false,
        reason: "artifact_report_hash_missing",
        detail: `No report stated a sha256 for ${report.containerPath}; the artifact cannot be confirmed.`,
      };
    }
    return { ok: true, hostPath: candidate, containerPath: report.containerPath, sha256 };
  }
  if (outsideMount) return { ok: false, ...outsideMount };
  return {
    ok: false,
    reason: "artifact_report_disagrees_with_output",
    detail:
      `The build wrote one artifact to ${CONTAINER_ARTIFACT_DIR}, but no report names it — reported ` +
      `instead: ${input.reports.map((r) => r.containerPath).join(", ")}. A report the build itself can ` +
      "print does not decide which file is the rebuild.",
  };
}

function lastHashFor(
  earlier: BuildArtifactReport[],
  candidate: string,
  artifactDir: string,
): string | undefined {
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const report = earlier[index];
    if (!report.sha256) continue;
    const resolved = resolveReportedArtifact(report.containerPath, artifactDir);
    if (resolved.ok && resolved.hostPath === candidate) return report.sha256;
  }
  return undefined;
}

export async function snapshotWasmPaths(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  await collectExistingWasm(root, found);
  return found;
}

async function collectExistingWasm(dir: string, found: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await collectExistingWasm(path, found);
      continue;
    }
    // Symlinks are not followed: `isFile()` is false for one.
    if (entry.isFile() && entry.name.endsWith(".wasm")) {
      found.add(resolve(path));
    }
  }
}

export function resolveReportedArtifact(
  containerPath: string,
  outDir: string,
): { ok: true; hostPath: string } | { ok: false; reason: RebuildErrorCode; detail: string } {
  const normalized = posix.normalize(containerPath);
  if (normalized !== `${CONTAINER_ARTIFACT_DIR}` && !normalized.startsWith(`${CONTAINER_ARTIFACT_DIR}/`)) {
    return {
      ok: false,
      reason: "artifact_report_outside_output_mount",
      detail:
        `The build tool reported an artifact at ${containerPath}, which is outside the ` +
        `dedicated output mount ${CONTAINER_ARTIFACT_DIR}.`,
    };
  }
  const relative = normalized.slice(CONTAINER_ARTIFACT_DIR.length + 1);
  return { ok: true, hostPath: join(outDir, ...relative.split("/")) };
}
