import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, "..");
const bundlePath = join(sdkRoot, "dist/index.js");
const fixtureRoot = resolve(sdkRoot, "../../test/fixtures/verifiers");

const WASM_HASH = "a".repeat(64);

/** Anchored, or a string literal containing "import" would match. */
const BUNDLE_IMPORT =
  /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|[\s;}])import\s*["']([^"']+)["']/gm;

async function bundleImports(): Promise<string[]> {
  const source = await readFile(bundlePath, "utf8");
  const specifiers = [...source.matchAll(BUNDLE_IMPORT)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/"));
  return [...new Set(specifiers)].sort();
}

/** Equality, not a denylist: an inlined package emits no import, so a grep would pass a bundle carrying all of Nest. */
async function assertImportsMatchDependencies(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const declared = Object.keys(manifest.dependencies ?? {}).sort();

  assert.deepEqual(
    await bundleImports(),
    declared,
    "the bundle's imports and its declared dependencies disagree — an inlined copy of a " +
      "metadata library gives a consumer two stores, and an undeclared import fails to resolve",
  );
}

async function assertDecoratorMetadataSurvived(): Promise<void> {
  const source = await readFile(bundlePath, "utf8");
  assert.ok(
    source.includes("design:type"),
    "the bundle carries no design:type metadata — nested validation would pass anything",
  );
}

async function browserBundle(): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scvs-sdk-browser-"));
  const outfile = join(outDir, "sdk.browser.mjs");
  await build({
    entryPoints: [bundlePath],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}

function fixtureFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = join(fixtureRoot, url.pathname);
    try {
      return new Response(await readFile(path, "utf8"), { status: 200 });
    } catch {
      return new Response("{}", { status: 404 });
    }
  }) as typeof fetch;
}

async function main(): Promise<void> {
  await assertImportsMatchDependencies();
  await assertDecoratorMetadataSurvived();

  const outfile = await browserBundle();
  try {
    const sdk = (await import(pathToFileURL(outfile).toString())) as typeof import("../src/index.js");

    const tvl = JSON.parse(
      await readFile(join(fixtureRoot, "trusted-verifiers.local.json"), "utf8"),
    ) as Parameters<typeof sdk.newClient>[0]["tvl"];

    const client = sdk.newClient({
      tvl,
      baseUrl: "https://fixtures.example.com/",
      fetch: fixtureFetch(),
    });

    const aggregate = await client.registry.byHash(WASM_HASH);
    assert.equal(aggregate.schema_version, "1.0");
    assert.equal(
      aggregate.source_code_verifications.map((entry) => entry.status).join(","),
      "verified,mismatched",
      "the browser bundle did not aggregate the fixtures",
    );
    assert.equal(aggregate.agreement, "disputed");

    assert.throws(() => sdk.newClient({ tvl: {} as never }), /schema|verifiers/i);

    console.log(
      "SDK browser-bundle check passed (imports match declared dependencies, decorator metadata " +
        "intact, bundles for --platform=browser, and aggregates the fixtures with validation intact)",
    );
  } finally {
    await rm(dirname(outfile), { recursive: true, force: true });
  }
}

await main();
