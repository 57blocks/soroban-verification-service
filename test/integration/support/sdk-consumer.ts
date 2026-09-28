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
    resultRoot: string;
    verifierId?: string;
    outcome: string;
    manifestId?: string;
    policyId?: string;
  }>;
  requests: string[];
};

// Resolved from this file, not cwd: `pnpm --filter … exec` changes the working directory.
const sdkConsumerCwd = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "clients", "sdk");

const sdkEntry = resolve(sdkConsumerCwd, "dist", "index.js");

const inlinedSources = [
  resolve(sdkConsumerCwd, "src"),
  resolve(sdkConsumerCwd, "..", "..", "packages", "core", "src"),
  resolve(sdkConsumerCwd, "..", "..", "packages", "storage-layout", "src"),
];

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

export function runSdkConsumer(input: SdkConsumerInput): SdkConsumerResult {
  if (!existsSync(sdkEntry)) {
    throw new Error(
      `soroban-verification-client is not built: ${sdkEntry} is missing. Run \`pnpm exec turbo run build --filter=soroban-verification-client\`.`,
    );
  }

  const builtAtMs = statSync(sdkEntry).mtimeMs;
  const changedAtMs = Math.max(...inlinedSources.map(newestMtimeMs));
  if (changedAtMs > builtAtMs) {
    throw new Error(
      `soroban-verification-client's bundle is older than the sources it inlines ` +
        `(built ${new Date(builtAtMs).toISOString()}, newest source ${new Date(changedAtMs).toISOString()}). ` +
        `These cases would validate the deployment against a stale contract and blame the deployment. ` +
        `Run \`pnpm exec turbo run build --filter=soroban-verification-client\` and re-run.`,
    );
  }

  const consumer = `
    import { newClient } from "soroban-verification-client";

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

  // A long-lived parent can hold a Homebrew Cellar node path that an upgrade removed.
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
