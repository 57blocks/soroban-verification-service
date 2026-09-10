import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SdkConsumerInput = {
  tvl?: unknown;
  tvlUrl?: string;
  tvlFile?: string;
  wasmHash: string;
};

export type SdkConsumerResult = {
  aggregate: unknown;
  discoveries: Array<{
    /**
     * The result root, and what a caller correlates on: it is the identity the SEP defines and the one
     * field `ResolvedVerifier` guarantees. `id` is optional and implementation-local, so a harness that
     * keyed on it would drop any entry that carries none.
     */
    resultRoot: string;
    /** Optional in the published schema, so optional here. Never a correlation key. */
    verifierId?: string;
    /** `available` | `not_advertised` | `unavailable` — see `VerifierDiscovery` in the SDK. */
    outcome: string;
    /** Both present only on `available`; a manifest is optional and its absence is not a failure. */
    manifestId?: string;
    policyId?: string;
  }>;
  requests: string[];
};

// `pnpm --filter … exec` starts Jest from the selected package directory, while callers using the workspace
// root have a different cwd.
const sdkConsumerCwd = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "clients", "sdk");

// The consumer imports the package by name, so an unbuilt SDK arrives as ERR_MODULE_NOT_FOUND from an evaluated
// module — a stack that names neither this suite nor the missing build step.
const sdkEntry = resolve(sdkConsumerCwd, "dist", "index.js");

/** The sources the bundle inlines: a change in either reaches these cases only after a rebuild. */
const inlinedSources = [
  resolve(sdkConsumerCwd, "src"),
  resolve(sdkConsumerCwd, "..", "..", "packages", "core", "src"),
  resolve(sdkConsumerCwd, "..", "..", "packages", "storage-layout", "src"),
];

/** Newest mtime under a directory, or 0 when it does not exist. */
function newestMtimeMs(path: string): number {
  let newest = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else newest = Math.max(newest, statSync(child).mtimeMs);
    }
  };
  if (!existsSync(path)) return 0;
  walk(path);
  return newest;
}

/** Runs the SDK's built entry from an isolated consumer process. */
export function runSdkConsumer(input: SdkConsumerInput): SdkConsumerResult {
  if (!existsSync(sdkEntry)) {
    throw new Error(
      `@scvs/sdk is not built: ${sdkEntry} is missing. Run \`pnpm exec turbo run build --filter=@scvs/sdk\`.`,
    );
  }

  // A stale bundle runs, validates the deployment against a contract that has moved, and blames the
  // deployment. CI has a build step; a local run has none, so this is it.
  const builtAtMs = statSync(sdkEntry).mtimeMs;
  const changedAtMs = Math.max(...inlinedSources.map(newestMtimeMs));
  if (changedAtMs > builtAtMs) {
    throw new Error(
      `@scvs/sdk's bundle is older than the sources it inlines ` +
        `(built ${new Date(builtAtMs).toISOString()}, newest source ${new Date(changedAtMs).toISOString()}). ` +
        `These cases would validate the deployment against a stale contract and blame the deployment. ` +
        `Run \`pnpm exec turbo run build --filter=@scvs/sdk\` and re-run.`,
    );
  }

  const consumer = `
    import { newClient } from "@scvs/sdk";

    import { readFile } from "node:fs/promises";

    const input = JSON.parse(process.env.SCVS_SDK_E2E_INPUT);
    const requests = [];
    const nativeFetch = globalThis.fetch;
    const tvl = input.tvlFile
      ? JSON.parse(await readFile(input.tvlFile, "utf8"))
      : input.tvlUrl
        ? await (requests.push(input.tvlUrl), nativeFetch(input.tvlUrl)).then(async (response) => {
            if (!response.ok) throw new Error("TVL request failed: " + response.status);
            return response.json();
          })
        : input.tvl;
    const client = newClient({
      tvl,
      fetch: async (url, options) => {
        requests.push(String(url));
        return nativeFetch(url, options);
      },
    });
    const [aggregate, discovered] = await Promise.all([
      client.registry.byHash(input.wasmHash),
      client.discover(),
    ]);
    console.log(JSON.stringify({
      aggregate,
      discoveries: discovered.map((entry) => ({
        resultRoot: entry.verifier.url,
        verifierId: entry.verifier.id,
        outcome: entry.outcome,
        manifestId: entry.outcome === "available" ? entry.manifest.id : undefined,
        policyId: entry.outcome === "available" ? entry.policy.id : undefined,
      })),
      requests,
    }));
  `;
  const runConsumer = (nodeExecutable: string) => spawnSync(nodeExecutable, ["--input-type=module", "--eval", consumer], {
    cwd: sdkConsumerCwd,
    env: { ...process.env, SCVS_SDK_E2E_INPUT: JSON.stringify(input) },
    encoding: "utf8",
  });

  // A long-lived parent process can retain a Homebrew Cellar path removed by a Node upgrade.
  let result = runConsumer(process.execPath);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    result = runConsumer("node");
  }

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `SDK consumer failed (exit ${result.status ?? "unknown"}): ${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as SdkConsumerResult;
  } catch {
    throw new Error(`SDK consumer emitted invalid JSON: ${result.stdout}`);
  }
}
