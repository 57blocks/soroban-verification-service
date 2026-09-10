import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type HostManifest = {
  host_label: string;
  fixtures: Record<string, { sha256: string; reference_alignment?: unknown }>;
};

const enabled = process.env.SCVS_DIFFERENTIAL === "1" && process.env.SCVS_COMPARE_HOST_MANIFESTS === "1";
const maybeDescribe = enabled ? describe : describe.skip;

maybeDescribe("differential two-host reproducibility", () => {
  it("matches recorded fixture hashes across host manifests", () => {
    const manifests = readHostManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(2);

    const [baseline, ...others] = manifests;
    for (const manifest of others) {
      expect(Object.keys(manifest.fixtures).sort()).toEqual(Object.keys(baseline.fixtures).sort());
      for (const [fixtureId, baselineResult] of Object.entries(baseline.fixtures)) {
        expect(manifest.fixtures[fixtureId]?.sha256).toBe(baselineResult.sha256);
      }
    }
  });
});

function readHostManifests(): HostManifest[] {
  const resultsDir = join(repoRoot(), "test", "differential", "results");
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as HostManifest);
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
