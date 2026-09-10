import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The verifier-owned pins for one composition template, read from
 * `docker/composed-environments/<template_version>/template.json`.
 */
export type CompositionTemplate = {
  templateVersion: string;
  /** `docker build --platform`. */
  platform: string;
  baseImage: { reference: string; digest: string };
  rustup: { version: string; targetTriple: string; installerSha256: string };
  rust: { profile: string; targets: string[] };
  stellarCli: { repository: string; assetTargetTriple: string };
  /**
   * Shared libraries a pinned component needs at run time and the pinned base image does not supply. **Empty is
   * the expected steady state**.
   */
  runtimeLibraries: RuntimeLibraryPin[];
};

/** One pinned OS package supplying a runtime library the base image lacks. */
export type RuntimeLibraryPin = {
  /** Also the filename it lands under in the build context, hence the charset guard in `assertUsablePins`. */
  name: string;
  /** Recorded so an operator reading the recipe sees which build of the library ran, not just a hash. */
  version: string;
  url: string;
  sha256: string;
};

/** Becomes `ComposerArtifact.reason`, and from there `Environment.errorCode`. */
export type CompositionTemplateErrorReason = "composition_template_missing" | "composition_template_invalid";

export class CompositionTemplateError extends Error {
  readonly reason: CompositionTemplateErrorReason;

  constructor(message: string, reason: CompositionTemplateErrorReason = "composition_template_invalid") {
    super(message);
    this.name = "CompositionTemplateError";
    this.reason = reason;
  }
}

const HEX_64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The all-zero placeholders `template.json` ships with. */
const PLACEHOLDER_HEX = "0".repeat(64);

export function templateDirFor(templateRoot: string, templateVersion: string): string {
  // `template_version` reaches us from `ComposerJobParams`, which the orchestrator populated from its own
  // `CURRENT_COMPOSE_TEMPLATE_VERSION` constant — not from anything submitted.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(templateVersion)) {
    throw new CompositionTemplateError(
      `template_version ${JSON.stringify(templateVersion)} is not a valid directory segment.`,
    );
  }
  return join(templateRoot, templateVersion);
}

export async function loadCompositionTemplate(
  templateRoot: string,
  templateVersion: string,
): Promise<CompositionTemplate> {
  const dir = templateDirFor(templateRoot, templateVersion);
  const path = join(dir, "template.json");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // Nothing is wrong with the template; it is not here. See `CompositionTemplateErrorReason`.
    throw new CompositionTemplateError(
      `Could not read composition template ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        "The composer image must ship every template version any orchestrator may ask for — if this " +
        "version exists in the repository, this image predates it and needs rebuilding.",
      "composition_template_missing",
    );
  }

  const parsed = JSON.parse(raw) as Record<string, any>;
  if (parsed.schema !== "scvs-composition-template-v1") {
    throw new CompositionTemplateError(
      `${path}: unsupported schema ${JSON.stringify(parsed.schema)}.`,
    );
  }
  if (parsed.template_version !== templateVersion) {
    // The directory name and the file's own declaration must agree, or `recipe_sha256` would record a version
    // that does not describe the pins actually used.
    throw new CompositionTemplateError(
      `${path}: declares template_version ${JSON.stringify(parsed.template_version)} but lives in ` +
        `directory ${JSON.stringify(templateVersion)}.`,
    );
  }

  const template: CompositionTemplate = {
    templateVersion,
    platform: String(parsed.platform ?? ""),
    baseImage: {
      reference: String(parsed.base_image?.reference ?? ""),
      digest: String(parsed.base_image?.digest ?? ""),
    },
    rustup: {
      version: String(parsed.rustup?.version ?? ""),
      targetTriple: String(parsed.rustup?.target_triple ?? ""),
      installerSha256: String(parsed.rustup?.installer_sha256 ?? "").toLowerCase(),
    },
    rust: {
      profile: String(parsed.rust?.profile ?? "minimal"),
      targets: Array.isArray(parsed.rust?.targets) ? parsed.rust.targets.map(String) : [],
    },
    stellarCli: {
      repository: String(parsed.stellar_cli?.repository ?? ""),
      assetTargetTriple: String(parsed.stellar_cli?.asset_target_triple ?? ""),
    },
    // Absent means none, so template `v1` — which declares no section — keeps loading exactly as before.
    runtimeLibraries: Array.isArray(parsed.runtime_libraries?.packages)
      ? parsed.runtime_libraries.packages.map((entry: Record<string, unknown>) => ({
          name: String(entry?.name ?? ""),
          version: String(entry?.version ?? ""),
          url: String(entry?.url ?? ""),
          sha256: String(entry?.sha256 ?? "").toLowerCase(),
        }))
      : [],
  };

  assertUsablePins(path, template);
  return template;
}

function assertUsablePins(path: string, template: CompositionTemplate): void {
  if (!/^linux\/[a-z0-9]+$/.test(template.platform)) {
    // Not inferred from the build host, on purpose: the composed image is run by the *builder* fleet (arm64
    // Graviton), so an image built for the host that happened to compose it would fail there rather than here.
    throw new CompositionTemplateError(
      `${path}: platform must be an explicit linux/<arch> value such as linux/arm64, got ` +
        `${JSON.stringify(template.platform)}. See that field's own comment for why it is not inferred.`,
    );
  }
  if (!DIGEST.test(template.baseImage.digest)) {
    throw new CompositionTemplateError(
      `${path}: base_image.digest must be sha256:<64 lowercase hex>, got ${JSON.stringify(template.baseImage.digest)}.`,
    );
  }
  if (template.baseImage.digest === `sha256:${PLACEHOLDER_HEX}`) {
    throw new CompositionTemplateError(
      `${path}: base_image.digest is still the all-zero placeholder. Pin a real base image digest ` +
        "before composing — see that field's own comment for the command.",
    );
  }
  if (!HEX_64.test(template.rustup.installerSha256)) {
    throw new CompositionTemplateError(
      `${path}: rustup.installer_sha256 must be 64 lowercase hex chars, got ` +
        `${JSON.stringify(template.rustup.installerSha256)}.`,
    );
  }
  if (template.rustup.installerSha256 === PLACEHOLDER_HEX) {
    throw new CompositionTemplateError(
      `${path}: rustup.installer_sha256 is still the all-zero placeholder. Pin the real checksum before ` +
        "composing — see that field's own comment for the command.",
    );
  }
  if (!template.rustup.version || !template.rustup.targetTriple) {
    throw new CompositionTemplateError(`${path}: rustup.version and rustup.target_triple are required.`);
  }
  if (!template.stellarCli.repository || !template.stellarCli.assetTargetTriple) {
    throw new CompositionTemplateError(
      `${path}: stellar_cli.repository and stellar_cli.asset_target_triple are required.`,
    );
  }
  if (template.rust.targets.length === 0) {
    throw new CompositionTemplateError(
      `${path}: rust.targets must name at least one target — a composed environment with no Soroban ` +
        "target cannot build a contract.",
    );
  }
  assertUsableRuntimeLibraries(path, template.runtimeLibraries);
}

/**
 * Every runtime-library pin, checked with the same severity as the rustup pin above and for the same reason:
 * these values go straight into the published recipe, and this is the last place a malformed one is cheap.
 */
function assertUsableRuntimeLibraries(path: string, libraries: RuntimeLibraryPin[]): void {
  const seen = new Set<string>();
  for (const library of libraries) {
    // `name` is interpolated into a filename in the build context and into the template's `COPY`, so it is
    // constrained to what a package name can be rather than trusted for coming from a reviewed file.
    if (!/^[a-z0-9][a-z0-9.+-]*$/.test(library.name)) {
      throw new CompositionTemplateError(
        `${path}: runtime_libraries.packages[].name ${JSON.stringify(library.name)} is not a usable ` +
          "package name; it becomes a filename in the build context.",
      );
    }
    if (seen.has(library.name)) {
      // Two entries under one name would have the second overwrite the first in the context while both appeared
      // in the recipe — a recipe describing bytes that are not in the image.
      throw new CompositionTemplateError(
        `${path}: runtime_libraries.packages[] names ${JSON.stringify(library.name)} twice.`,
      );
    }
    seen.add(library.name);

    if (!library.version) {
      throw new CompositionTemplateError(
        `${path}: runtime_libraries.packages[${library.name}].version is required — the recipe records ` +
          "which build of the library ran, not only its hash.",
      );
    }
    if (!library.url.startsWith("https://")) {
      throw new CompositionTemplateError(
        `${path}: runtime_libraries.packages[${library.name}].url must be https, got ` +
          `${JSON.stringify(library.url)}.`,
      );
    }
    if (!HEX_64.test(library.sha256)) {
      throw new CompositionTemplateError(
        `${path}: runtime_libraries.packages[${library.name}].sha256 must be 64 lowercase hex chars, got ` +
          `${JSON.stringify(library.sha256)}.`,
      );
    }
    if (library.sha256 === PLACEHOLDER_HEX) {
      throw new CompositionTemplateError(
        `${path}: runtime_libraries.packages[${library.name}].sha256 is still the all-zero placeholder. ` +
          "Pin the checksum the distro archive's own signed index publishes before composing.",
      );
    }
  }
}
