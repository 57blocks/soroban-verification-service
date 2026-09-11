import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompositionTemplateError,
  loadCompositionTemplate,
  templateDirFor,
} from "../src/modules/composer/template.js";

/** `template.json` is the file `template_version` *names*, and `recipe_sha256` hashes over the version string. */
const GOOD = {
  schema: "scvs-composition-template-v1",
  template_version: "v1",
  platform: "linux/arm64",
  base_image: { reference: "docker.io/library/buildpack-deps", digest: "sha256:" + "a".repeat(64) },
  rustup: {
    version: "1.29.0",
    target_triple: "aarch64-unknown-linux-gnu",
    installer_sha256: "b".repeat(64),
  },
  rust: { profile: "minimal", targets: ["wasm32v1-none"] },
  stellar_cli: { repository: "stellar/stellar-cli", asset_target_triple: "aarch64-unknown-linux-gnu" },
};

async function withTemplate(body: unknown, version = "v1"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tmpl-"));
  await mkdir(join(root, version), { recursive: true });
  await writeFile(join(root, version, "template.json"), JSON.stringify(body));
  return root;
}

describe("loadCompositionTemplate", () => {
  it("loads a well-formed template", async () => {
    const root = await withTemplate(GOOD);
    const template = await loadCompositionTemplate(root, "v1");
    expect(template.templateVersion).toBe("v1");
    expect(template.rustup.installerSha256).toBe("b".repeat(64));
    expect(template.rust.targets).toEqual(["wasm32v1-none"]);
  });

  it("rejects the all-zero placeholder base image digest the file ships with", async () => {
    // `template.json` is committed with placeholders so the shape is reviewable before the real pins are
    // chosen.
    const root = await withTemplate({
      ...GOOD,
      base_image: { ...GOOD.base_image, digest: "sha256:" + "0".repeat(64) },
    });
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/all-zero placeholder/);
  });

  it("rejects the all-zero placeholder rustup checksum", async () => {
    const root = await withTemplate({
      ...GOOD,
      rustup: { ...GOOD.rustup, installer_sha256: "0".repeat(64) },
    });
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/all-zero placeholder/);
  });

  it("rejects a tag-shaped base image reference instead of a digest", async () => {
    const root = await withTemplate({
      ...GOOD,
      base_image: { reference: "docker.io/library/buildpack-deps", digest: "bookworm" },
    });
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/must be sha256:/);
  });

  it("rejects a template whose declared version disagrees with its directory", async () => {
    const root = await withTemplate({ ...GOOD, template_version: "v2" }, "v1");
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/but lives in directory/);
  });

  it("requires an explicit platform rather than inheriting the build host's", async () => {
    // The composed image is run by the *builder* fleet (arm64 Graviton), not by whatever composed it.
    const root = await withTemplate({ ...GOOD, platform: undefined });
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/platform must be an explicit/);

    const bogus = await withTemplate({ ...GOOD, platform: "arm64" });
    await expect(loadCompositionTemplate(bogus, "v1")).rejects.toThrow(/platform must be an explicit/);
  });

  it("rejects a template with no Soroban target", async () => {
    const root = await withTemplate({ ...GOOD, rust: { profile: "minimal", targets: [] } });
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/at least one target/);
  });

  it("reports a missing template clearly rather than as a parse error", async () => {
    const root = await withTemplate(GOOD);
    await expect(loadCompositionTemplate(root, "v9")).rejects.toThrow(
      /must ship every template version/,
    );
  });

  it("distinguishes a template that is absent from one that is malformed", async () => {
    // `CURRENT_COMPOSE_TEMPLATE_VERSION` moved to `v2` while the deployed composer image was still built from a
    // pre-`v2` commit, so the orchestrator asked a `v1`-only image for `v2`.
    const root = await withTemplate(GOOD);
    await expect(loadCompositionTemplate(root, "v9")).rejects.toMatchObject({
      reason: "composition_template_missing",
    });

    const malformed = await withTemplate({ ...GOOD, rustup: { ...GOOD.rustup, installer_sha256: "nope" } });
    await expect(loadCompositionTemplate(malformed, "v1")).rejects.toMatchObject({
      reason: "composition_template_invalid",
    });
  });

  it("defaults an unlabelled template error to invalid, never to missing", async () => {
    // `missing` is the code an operator may safely bulk-reset environment rows on
    // (`eng-tools/reset-failed-environments.mjs`), so a new throw site that forgot its reason must not silently
    // inherit it.
    const root = await withTemplate({ ...GOOD, template_version: "v2" }, "v1");
    await expect(loadCompositionTemplate(root, "v1")).rejects.toMatchObject({
      reason: "composition_template_invalid",
    });
    expect(() => templateDirFor("/templates", "../escape")).toThrow(
      expect.objectContaining({ reason: "composition_template_invalid" }),
    );
  });
});

/**
 * `runtime_libraries` exists because template v1 shipped without it and every composition it attempted failed
 * `smoke_test_failed`.
 */
describe("loadCompositionTemplate: runtime_libraries", () => {
  const LIBRARY = {
    name: "libdbus-1-3",
    version: "1.14.10-1~deb12u1",
    url: "https://snapshot.debian.org/archive/debian/20230924T084440Z/pool/main/d/dbus/libdbus-1-3_1.14.10-1~deb12u1_arm64.deb",
    sha256: "2a423794f44ee756f70fda67c6e47b15afe3dd22cd69e51f5d14d2ec9538f806",
  };
  const withLibraries = (packages: unknown[]) => ({ ...GOOD, runtime_libraries: { packages } });

  it("loads a template that pins one", async () => {
    const root = await withTemplate(withLibraries([LIBRARY]));
    const template = await loadCompositionTemplate(root, "v1");
    expect(template.runtimeLibraries).toEqual([LIBRARY]);
  });

  it("treats an absent section as none, so v1-shaped templates keep loading", async () => {
    // Empty is the expected steady state, not a special case — a template whose base image supplies everything
    // its components need declares nothing here.
    const root = await withTemplate(GOOD);
    const template = await loadCompositionTemplate(root, "v1");
    expect(template.runtimeLibraries).toEqual([]);
  });

  it("rejects a name that is not usable as a filename in the build context", async () => {
    // `name` becomes `<name>.deb` in the context and the template's `COPY` target.
    for (const name of ["../etc/passwd", "lib/dbus", "", "Libdbus", "-libdbus"]) {
      const root = await withTemplate(withLibraries([{ ...LIBRARY, name }]));
      await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/not a usable package name/);
    }
  });

  it("rejects the same name twice, which would put bytes in the recipe that are not in the image", async () => {
    const root = await withTemplate(withLibraries([LIBRARY, { ...LIBRARY, sha256: "c".repeat(64) }]));
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/twice/);
  });

  it("rejects a non-https url", async () => {
    const root = await withTemplate(withLibraries([{ ...LIBRARY, url: "http://deb.debian.org/x.deb" }]));
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/must be https/);
  });

  it("rejects a malformed or placeholder checksum", async () => {
    const malformed = await withTemplate(withLibraries([{ ...LIBRARY, sha256: "not-a-hash" }]));
    await expect(loadCompositionTemplate(malformed, "v1")).rejects.toThrow(/64 lowercase hex/);

    const placeholder = await withTemplate(withLibraries([{ ...LIBRARY, sha256: "0".repeat(64) }]));
    await expect(loadCompositionTemplate(placeholder, "v1")).rejects.toThrow(/all-zero placeholder/);
  });

  it("requires a version, so the recipe records which build of the library ran", async () => {
    const root = await withTemplate(withLibraries([{ ...LIBRARY, version: "" }]));
    await expect(loadCompositionTemplate(root, "v1")).rejects.toThrow(/version is required/);
  });
});

describe("templateDirFor", () => {
  it("refuses a template_version that is not a single path segment", () => {
    // Chain-derived values never reach this parameter — the orchestrator populates it from its own constant —
    // but it is interpolated into a filesystem path, so it is validated rather than trusted.
    for (const bad of ["../v1", "v1/../..", "/etc", "a/b", ""]) {
      expect(() => templateDirFor("/templates", bad)).toThrow(CompositionTemplateError);
    }
    expect(templateDirFor("/templates", "v1")).toBe("/templates/v1");
  });
});
