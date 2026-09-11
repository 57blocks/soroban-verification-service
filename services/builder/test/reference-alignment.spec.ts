import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReferenceAlignment, referenceAlignment } from "../src/modules/builder/reference-alignment.js";

/**
 * This suite asserted `MAIN_SHA` plus two PR SHAs, because `docker/stellar-cli.pin` described a three-way merge
 * CI compiled: the service needed `contract verify` and `contract archive`, which are in no stellar-cli
 * release.
 */
const VERSION = "v28.0.0";

describe("referenceAlignment", () => {
  it("parses the pinned official release from the pin file", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-pin-"));
    const pinFile = join(root, "stellar-cli.pin");
    await writeFile(
      pinFile,
      [
        "# comment",
        `STELLAR_CLI_VERSION=${VERSION}`,
        "STELLAR_CLI_TARBALL_SHA256_ARM64=8d8e5ea9bb441a19e99a7a7a4809df3f758c9654265c76953436fb7e9288b9ff",
        "",
      ].join("\n"),
    );

    expect(referenceAlignment(pinFile)).toEqual({
      repo: "stellar/stellar-cli",
      version: VERSION,
      read_from: "docker/stellar-cli.pin",
    });
  });

  it("★ reads the repository's real pin, so a pin edit that breaks this fails here", () => {
    // The one assertion that cannot drift with the fixture above: `referenceAlignment()` with no argument
    // locates `docker/stellar-cli.pin` itself.
    const alignment = referenceAlignment();
    expect(alignment.repo).toBe("stellar/stellar-cli");
    expect(alignment.version).toMatch(/^v?\d+\.\d+\.\d+/);
    expect(alignment.read_from).toBe("docker/stellar-cli.pin");
  });

  it("requires the version so the reference cannot float", () => {
    expect(() => parseReferenceAlignment("# nothing pinned\n")).toThrow(
      "docker/stellar-cli.pin is missing STELLAR_CLI_VERSION=<semver>",
    );
  });

  it("refuses a version that is not a release identifier", () => {
    for (const value of ["main", "latest", "v28", "28.0", ""]) {
      expect(() => parseReferenceAlignment(`STELLAR_CLI_VERSION=${value}\n`)).toThrow(
        "docker/stellar-cli.pin is missing STELLAR_CLI_VERSION=<semver>",
      );
    }
  });

  it("ignores the digest lines the pin carries beside the version", () => {
    // Those exist for `scripts/ci/fetch-or-build-stellar-cli.sh`, which verifies the download and the cache
    // against them.
    const alignment = parseReferenceAlignment(
      [
        `STELLAR_CLI_VERSION=${VERSION}`,
        "STELLAR_CLI_ASSET_TEMPLATE='stellar-cli-{version}-{triple}.tar.gz'",
        "STELLAR_CLI_BINARY_SHA256_AMD64=bbe5c76a3bf8b4e1103cdd8726d9497b7dbb735e766d5b0d448b787c9b1293e0",
      ].join("\n"),
    );
    expect(alignment).toEqual({
      repo: "stellar/stellar-cli",
      version: VERSION,
      read_from: "docker/stellar-cli.pin",
    });
  });
});
