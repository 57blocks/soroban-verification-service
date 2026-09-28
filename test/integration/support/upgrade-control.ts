import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function upgradeFixtureToV2(): void {
  const result = spawnSync(
    "bash",
    ["test/fixtures/e2e/set-upgrade-testnet-version.sh", "new"],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`F-UPG v2 upgrade control exited with status ${result.status ?? "unknown"}.`);
  }
}
