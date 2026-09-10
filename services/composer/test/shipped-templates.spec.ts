import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_COMPOSE_TEMPLATE_VERSION } from "@scvs/core";
import { loadCompositionTemplate } from "../src/modules/composer/template.js";

/** The templates this repository actually ships, checked as data rather than through a stub. */

const TEMPLATE_ROOT = fileURLToPath(new URL("../../../docker/composed-environments", import.meta.url));

/** Read synchronously at module scope because `describe.each` needs the list before any test runs. */
const TEMPLATE_VERSIONS: string[] = readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("the composition templates this repository ships", () => {
  it("ships the version CURRENT_COMPOSE_TEMPLATE_VERSION names", async () => {
    // The composer image bakes this directory in and the orchestrator asks for this constant by name, so a bump
    // with no matching directory fails every composition with `composition_template_invalid`.
    expect(TEMPLATE_VERSIONS).toContain(CURRENT_COMPOSE_TEMPLATE_VERSION);
  });

  it("loads every shipped template through the real loader, pins and all", async () => {
    // Includes retired versions on purpose: they stay on disk (a template directory is append-only), the image
    // still ships them, and an orchestrator replaying an old `Environment` row can still ask for one.
    for (const version of TEMPLATE_VERSIONS) {
      await expect(loadCompositionTemplate(TEMPLATE_ROOT, version)).resolves.toMatchObject({
        templateVersion: version,
      });
    }
  });

  describe.each(TEMPLATE_VERSIONS)("%s", (version) => {
    it("declares the same template_version as its directory name", async () => {
      const template = await loadCompositionTemplate(TEMPLATE_ROOT, version);
      expect(template.templateVersion).toBe(version);
    });

    it("labels the image with its own version, not the one it was copied from", async () => {
      // The composer does not read this label — an operator does.
      const dockerfile = await readFile(join(TEMPLATE_ROOT, version, "Dockerfile"), "utf8");
      expect(dockerfile).toContain(`org.stellar.scvs.template-version="${version}"`);
    });

    it("installs exactly the runtime libraries it pins", async () => {
      const template = await loadCompositionTemplate(TEMPLATE_ROOT, version);
      const dockerfile = await readFile(join(TEMPLATE_ROOT, version, "Dockerfile"), "utf8");

      const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)\.deb\s/gm)].map((match) => match[1]).sort();
      const pinned = template.runtimeLibraries.map((library) => library.name).sort();
      expect(copied).toEqual(pinned);
    });

    it("declares the ENTRYPOINT the builder's launch form depends on", async () => {
      // `services/builder` launches a rebuild as `docker run <image> <bldarg…> --manifest-path …`, where
      // `bldarg` is SEP-58's recorded entry-point arguments — `contract build` by default.
      const dockerfile = await readFile(join(TEMPLATE_ROOT, version, "Dockerfile"), "utf8");
      const declared = /^ENTRYPOINT\s+\[\s*"stellar"\s*\]\s*$/m.test(dockerfile);
      if (version === "v1" || version === "v2") {
        // Recorded rather than skipped: these two are why the assertion exists, and an append-only template
        // directory cannot be fixed retroactively.
        expect(declared).toBe(false);
        return;
      }
      expect(declared).toBe(true);
      // `buildpack-deps` leaves `CMD ["bash"]` behind and ENTRYPOINT does not clear it, so a bare `docker run
      // <image>` would become `stellar bash`.
      expect(/^CMD\s+\[\s*\]\s*$/m.test(dockerfile)).toBe(true);
    });

    it("installs every pinned library from the local file, never from a package repository", async () => {
      // An `apt-get install` here would be a mutable transaction wearing the same clothes.
      const dockerfile = await readFile(join(TEMPLATE_ROOT, version, "Dockerfile"), "utf8");
      expect(dockerfile).not.toMatch(/apt-get\s+install|apt\s+install|dpkg\s+-i\s+\w+[^./]*$/m);

      const template = await loadCompositionTemplate(TEMPLATE_ROOT, version);
      for (const library of template.runtimeLibraries) {
        expect(dockerfile).toContain(`dpkg -i /tmp/${library.name}.deb`);
      }
    });
  });

  it("pins v2's libdbus-1-3 at the checksum Debian's signed index publishes", async () => {
    // If this ever needs changing, it needs changing here too — deliberately.
    const template = await loadCompositionTemplate(TEMPLATE_ROOT, "v2");
    expect(template.runtimeLibraries).toEqual([
      {
        name: "libdbus-1-3",
        version: "1.14.10-1~deb12u1",
        url: "https://snapshot.debian.org/archive/debian/20230924T084440Z/pool/main/d/dbus/libdbus-1-3_1.14.10-1~deb12u1_arm64.deb",
        sha256: "2a423794f44ee756f70fda67c6e47b15afe3dd22cd69e51f5d14d2ec9538f806",
      },
    ]);
  });

  it("keeps v2's non-library pins byte-identical to v1's", async () => {
    // `v2` exists to add one library and nothing else.
    const [v1, v2] = await Promise.all([
      loadCompositionTemplate(TEMPLATE_ROOT, "v1"),
      loadCompositionTemplate(TEMPLATE_ROOT, "v2"),
    ]);
    expect({ ...v2, templateVersion: "v1", runtimeLibraries: [] }).toEqual(v1);
  });
});
