import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "../../support/env.js";
import { fixtures, missingFixture } from "../../support/fixtures.js";
import { normalizeResultRoot } from "../../support/result-tree.js";

const repoRoot = resolve(process.cwd());
const outputDir = mkdtempSync(join(tmpdir(), "scvs-sdk-e2e-browser-"));
const bundlePath = join(outputDir, "sdk.browser.mjs");
const skipReason =
  !env.enabled
    ? "SCVS_E2E is not set — this suite drives a real deployment and never runs by default"
    : !env.allowBrowser
      ? "BROWSER requires SCVS_E2E_ALLOW_BROWSER=1"
      : !env.queryUrl
        ? "missing SCVS_E2E_QUERY_URL"
        : missingFixture("F-LEG-1");

function browserBundleUrl(): string {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "soroban-verification-client",
      "exec",
      "esbuild",
      "dist/index.js",
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--target=es2022",
      `--outfile=${bundlePath}`,
      "--log-level=error",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`SDK browser bundle failed: ${result.error?.message ?? result.stderr}`);
  }
  return `data:text/javascript;base64,${readFileSync(bundlePath).toString("base64")}`;
}

test.afterAll(() => rmSync(outputDir, { recursive: true, force: true }));

test.describe("E2E-SDK-04/browser — the built SDK aggregates two verifier roots in a browser", () => {
  test.skip(Boolean(skipReason), skipReason);

  test("bundles and executes against the deployed TVL without a hosted aggregate request", async ({ page }) => {
    const bundleUrl = browserBundleUrl();
    const result = await page.evaluate(
      async ({ bundleUrl, queryUrl, wasmHash }) => {
        const requests: string[] = [];
        const nativeFetch = window.fetch.bind(window);
        const sdk = await import(bundleUrl);
        const tvlResponse = await nativeFetch(`${queryUrl}/api/query/v1/verifiers`);
        if (!tvlResponse.ok) throw new Error(`TVL request failed: ${tvlResponse.status}`);
        const tvl = await tvlResponse.json();
        // Result roots, not display names (CV11). Returned raw: comparing roots is a stated rule and
        // half of it fails a legitimate verifier, so `normalizeResultRoot` runs on the Node side.
        const expectedRoots = tvl.verifiers
          .filter((verifier: { status: string }) => verifier.status === "active")
          .map((verifier: { url: string }) => verifier.url);
        const client = sdk.newClient({
          tvl,
          fetch: async (url: string, options?: RequestInit) => {
            requests.push(String(url));
            return nativeFetch(url, options);
          },
        });
        const aggregate = await client.registry.byHash(wasmHash);
        return { aggregate, requests, expectedRoots };
      },
      { bundleUrl, queryUrl: env.queryUrl!, wasmHash: fixtures.contracts["F-LEG-1"].wasm_hash! },
    );

    expect(result.expectedRoots.length).toBeGreaterThanOrEqual(2);
    expect(
      result.aggregate.source_code_verifications.map((entry: { verifier: { url?: string } }) =>
        normalizeResultRoot(entry.verifier.url ?? ""),
      ),
    ).toEqual(expect.arrayContaining(result.expectedRoots.map(normalizeResultRoot)));
    expect(result.requests.some((url) => url.startsWith(`${env.queryUrl}/api/query/v1/`))).toBe(false);
  });
});
