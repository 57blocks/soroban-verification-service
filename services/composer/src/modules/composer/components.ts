import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCliver } from "@scvs/core";
import type { OfficialComponent, RecordedToolchainPair } from "@scvs/core";
import type { CompositionTemplate } from "./template.js";

export class ComponentError extends Error {
  readonly reason: string;
  readonly context: Record<string, unknown>;

  constructor(reason: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "ComponentError";
    this.reason = reason;
    this.context = context;
  }
}

export type FetchedComponents = {
  components: OfficialComponent[];
  contextDir: string;
};

const GITHUB_API = "https://api.github.com";
const RUSTUP_ARCHIVE = "https://static.rust-lang.org/rustup/archive";
const RUSTUP_DIST = "https://static.rust-lang.org/dist";

const MAX_COMPONENT_BYTES = 256 * 1024 * 1024;

export async function fetchAndVerifyComponents(input: {
  pair: RecordedToolchainPair;
  template: CompositionTemplate;
  contextDir: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<FetchedComponents> {
  const { pair, template, contextDir, timeoutMs } = input;
  const doFetch = input.fetchImpl ?? fetch;

  await assertToolchainProvidesTargets({ pair, template, timeoutMs, fetchImpl: doFetch });

  const rustupUrl = `${RUSTUP_ARCHIVE}/${template.rustup.version}/${template.rustup.targetTriple}/rustup-init`;
  const rustupBytes = await download(doFetch, rustupUrl, timeoutMs, "rustup_installer");
  verifySha256(rustupBytes, template.rustup.installerSha256, {
    reason: "component_checksum_mismatch",
    component: "rustup_installer",
    source: rustupUrl,
  });
  await writeFile(join(contextDir, "rustup-init"), rustupBytes);

  const asset = await resolveStellarCliAsset(doFetch, pair.cliver, template, timeoutMs);
  const cliArchive = await download(doFetch, asset.downloadUrl, timeoutMs, "stellar_cli");
  verifySha256(cliArchive, asset.sha256, {
    reason: "component_checksum_mismatch",
    component: "stellar_cli",
    source: asset.downloadUrl,
  });
  await writeFile(join(contextDir, "stellar-cli-archive"), cliArchive);

  const runtimeLibraries: OfficialComponent[] = [];
  for (const library of template.runtimeLibraries) {
    const component = `runtime_library:${library.name}`;
    const bytes = await download(doFetch, library.url, timeoutMs, component);
    verifySha256(bytes, library.sha256, {
      reason: "component_checksum_mismatch",
      component,
      source: library.url,
    });
    await writeFile(join(contextDir, `${library.name}.deb`), bytes);
    runtimeLibraries.push({
      kind: "runtime_library",
      source: library.url,
      sha256: `sha256:${library.sha256}`,
    });
  }

  return {
    contextDir,
    components: [
      {
        kind: "base_image",
        source: template.baseImage.reference,
        sha256: template.baseImage.digest,
      },
      {
        kind: "rust_toolchain",
        source: rustupUrl,
        sha256: `sha256:${template.rustup.installerSha256}`,
      },
      {
        kind: "stellar_cli",
        source: asset.downloadUrl,
        sha256: `sha256:${asset.sha256}`,
      },
      ...runtimeLibraries,
    ],
  };
}

type StellarCliAsset = { downloadUrl: string; sha256: string; assetName: string };

async function resolveStellarCliAsset(
  doFetch: typeof fetch,
  cliver: string,
  template: CompositionTemplate,
  timeoutMs: number,
): Promise<StellarCliAsset> {
  // Chain-derived and interpolated into a URL path: validated, not trusted.
  const parsed = parseCliver(cliver);
  if (!parsed) {
    throw new ComponentError(
      "unaddressable_cliver",
      `The recorded cliver ${JSON.stringify(cliver)} is not a usable release tag.`,
      { cliver },
    );
  }
  const version = parsed.version;

  const url = `${GITHUB_API}/repos/${template.stellarCli.repository}/releases/tags/v${version}`;
  const response = await withTimeout(
    doFetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "scvs-composer",
      },
    }),
    timeoutMs,
    "stellar_cli_release_lookup",
  );

  if (response.status === 404) {
    throw new ComponentError(
      "unreleased_cli",
      `stellar-cli has no release tagged v${version}; this toolchain cannot be composed from released ` +
        "components.",
      { cliver, cliver_version: version, release_url: url },
    );
  }
  if (!response.ok) {
    throw new ComponentError(
      "component_unreachable",
      `GitHub's release API returned ${response.status} for v${version}.`,
      { cliver, cliver_version: version, status: response.status },
    );
  }

  const release = (await response.json()) as {
    assets?: Array<{ name?: string; browser_download_url?: string; digest?: string | null }>;
  };
  const triple = template.stellarCli.assetTargetTriple;
  const candidates = (release.assets ?? []).filter(
    (a) => typeof a.name === "string" && a.name.includes(triple) && /\.tar\.gz$/.test(a.name),
  );

  if (candidates.length === 0) {
    throw new ComponentError(
      "component_unreachable",
      `Release v${version} publishes no ${triple} .tar.gz asset.`,
      { cliver, target_triple: triple, asset_names: (release.assets ?? []).map((a) => a.name) },
    );
  }
  if (candidates.length > 1) {
    // Fail closed: two matching assets means the matching rule is wrong for this release.
    throw new ComponentError(
      "ambiguous_release_asset",
      `Release v${version} publishes ${candidates.length} assets matching ${triple}; refusing to guess.`,
      { cliver, candidates: candidates.map((a) => a.name) },
    );
  }

  const asset = candidates[0]!;
  if (!asset.browser_download_url) {
    throw new ComponentError("component_unreachable", `Asset ${asset.name} has no download URL.`, {
      cliver,
      asset_name: asset.name,
    });
  }
  const digest = asset.digest ?? undefined;
  if (!digest || !/^sha256:[0-9a-f]{64}$/i.test(digest)) {
    throw new ComponentError(
      "asset_digest_unavailable",
      `Release asset ${asset.name} carries no usable sha256 digest, so its bytes cannot be verified ` +
        "against anything official.",
      { cliver, asset_name: asset.name, reported_digest: digest ?? null },
    );
  }

  return {
    downloadUrl: asset.browser_download_url,
    sha256: digest.slice("sha256:".length).toLowerCase(),
    assetName: asset.name!,
  };
}

export async function assertToolchainProvidesTargets(input: {
  pair: RecordedToolchainPair;
  template: CompositionTemplate;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { pair, template, timeoutMs } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const targets = template.rust.targets;
  if (targets.length === 0) return;

  if (/-(nightly|beta)$/i.test(pair.rsver)) return;

  const url = `${RUSTUP_DIST}/channel-rust-${pair.rsver}.toml`;
  let manifest: string;
  try {
    const response = await withTimeout(
      doFetch(url, { headers: { "user-agent": "scvs-composer" } }),
      timeoutMs,
      "rust_channel_manifest",
    );
    if (!response.ok) return;
    manifest = await response.text();
  } catch {
    // Swallowed: a slow mirror must not become a verdict about the pair; the build still fails if the target is absent.
    return;
  }

  // The reader does not recognise this document — say nothing rather than report every target missing.
  if (!manifest.includes("[pkg.rust-std.target.")) return;

  const missing = targets.filter((target) => !declaresAvailableTarget(manifest, target));
  if (missing.length === 0) return;

  throw new ComponentError(
    "toolchain_target_unavailable",
    `Rust ${pair.rsver} does not distribute ${missing.join(", ")}, which template ` +
      `${template.templateVersion} requires. This toolchain cannot be composed by this template.`,
    {
      rsver: pair.rsver,
      cliver: pair.cliver,
      template_version: template.templateVersion,
      missing_targets: missing,
      required_targets: [...targets],
      manifest_url: url,
    },
  );
}

/** `[pkg.rust-std.target.<triple>]` followed, inside its own section, by `available = true`. */
function declaresAvailableTarget(manifest: string, target: string): boolean {
  const header = `[pkg.rust-std.target.${target}]`;
  const at = manifest.indexOf(header);
  if (at === -1) return false;
  const nextSection = manifest.indexOf("\n[", at + header.length);
  const section = manifest.slice(at, nextSection === -1 ? undefined : nextSection);
  return /available\s*=\s*true/.test(section);
}

async function download(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
  component: string,
): Promise<Buffer> {
  const response = await withTimeout(
    doFetch(url, { headers: { "user-agent": "scvs-composer" } }),
    timeoutMs,
    component,
  );
  if (!response.ok) {
    throw new ComponentError(
      "component_unreachable",
      `Fetching ${component} returned ${response.status}.`,
      { component, source: url, status: response.status },
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ComponentError("component_unreachable", `${component} downloaded as zero bytes.`, {
      component,
      source: url,
    });
  }
  if (bytes.byteLength > MAX_COMPONENT_BYTES) {
    throw new ComponentError(
      "component_too_large",
      `${component} is ${bytes.byteLength} bytes, over the ${MAX_COMPONENT_BYTES}-byte bound.`,
      { component, source: url, bytes: bytes.byteLength },
    );
  }
  return bytes;
}

function verifySha256(
  bytes: Buffer,
  expectedHex: string,
  context: { reason: string; component: string; source: string },
): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  const expected = expectedHex.toLowerCase();
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  const equal = a.length === b.length && timingSafeEqualBuffers(a, b);
  if (!equal) {
    throw new ComponentError(
      context.reason,
      `${context.component} failed checksum verification and was not used.`,
      {
        component: context.component,
        source: context.source,
        expected_sha256: expected,
        actual_sha256: actual,
      },
    );
  }
}

function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, component: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ComponentError(
                "component_unreachable",
                `Fetching ${component} exceeded ${timeoutMs}ms.`,
                { component, timeout_ms: timeoutMs },
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
