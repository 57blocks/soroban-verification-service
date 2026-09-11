import {
  ImageError,
  isImmutableTagConflict,
  parseInspectedImage,
  reportedVersion,
  registryRegion,
  reportsExpectedRev,
  reportsExpectedVersion,
} from "../src/modules/composer/image.js";
import type { CommandResult } from "../src/modules/composer/process-utils.js";

/** The pure half of `image.ts`. */

describe("reportsExpectedVersion", () => {
  it("accepts a version reported inside rustc's real output format", () => {
    expect(reportsExpectedVersion("rustc 1.95.0 (abcdef123 2026-01-01)", "1.95.0")).toBe(true);
  });

  it("accepts a version reported inside stellar-cli's real output format", () => {
    expect(reportsExpectedVersion("stellar 26.0.0\nsoroban-env-host 23.0.0", "26.0.0")).toBe(true);
  });

  it("accepts a version at the very end of the line", () => {
    expect(reportsExpectedVersion("rustc 1.95.0", "1.95.0")).toBe(true);
  });

  it("rejects the version the pair did not ask for", () => {
    // The PoC's actual finding: the official 26.0.0 image contains rust 1.94.1, while `stellar-cli-docker`'s
    // own matrix declares 1.93.
    expect(reportsExpectedVersion("rustc 1.94.1 (abcdef123 2026-01-01)", "1.93.0")).toBe(false);
  });

  it("★ rejects a version the expected one is merely a prefix of", () => {
    // The false-accept the old `includes()` rule had. `1.95` is not `1.95.0`, and treating it as such would let
    // the smoke test pass on an image built with a different toolchain than the pair recorded.
    expect(reportsExpectedVersion("rustc 1.95.0 (abcdef 2026-01-01)", "1.95")).toBe(false);
    expect(reportsExpectedVersion("rustc 1.9", "1.9")).toBe(true);
    expect(reportsExpectedVersion("rustc 1.90.0", "1.9")).toBe(false);
  });

  it("★ rejects a prerelease as a match for the release it is a candidate for", () => {
    // `26.0.0-rc.1` is not `26.0.0`. Semver's own separators (`-`, `+`) are excluded on the right for exactly
    // this case.
    expect(reportsExpectedVersion("stellar 26.0.0-rc.1", "26.0.0")).toBe(false);
    expect(reportsExpectedVersion("stellar 26.0.0+build.7", "26.0.0")).toBe(false);
  });

  it("rejects a version that only appears as the tail of a longer number", () => {
    expect(reportsExpectedVersion("rustc 11.95.0", "1.95.0")).toBe(false);
    expect(reportsExpectedVersion("stellar 126.0.0", "26.0.0")).toBe(false);
  });

  it("keeps looking after a bounded-on-one-side-only occurrence", () => {
    // The scan must not stop at the first textual hit: here the first `1.95.0` is part of `21.95.0` and the
    // real one comes later.
    expect(reportsExpectedVersion("build 21.95.0 rustc 1.95.0", "1.95.0")).toBe(true);
  });

  it("rejects an empty expected version rather than matching everything", () => {
    // `"".includes` semantics would make this vacuously true, which would silently disable the smoke test for a
    // pair whose version field was somehow blank.
    expect(reportsExpectedVersion("rustc 1.95.0", "")).toBe(false);
  });

  it("rejects when the tool printed nothing recognisable at all", () => {
    expect(reportsExpectedVersion("", "1.95.0")).toBe(false);
    expect(reportsExpectedVersion("command not found", "1.95.0")).toBe(false);
  });
});

describe("registryRegion", () => {
  it("derives the region from a well-formed ECR registry host", () => {
    expect(registryRegion("123456789012.dkr.ecr.eu-west-1.amazonaws.com")).toBe("eu-west-1");
    expect(registryRegion("123456789012.dkr.ecr.us-gov-west-1.amazonaws.com")).toBe("us-gov-west-1");
  });

  it("refuses a repository URI that was passed where a registry host belongs", () => {
    // The configured value is `<registry>/<repository>`; `pushComposedImage` splits it before calling this.
    expect(() =>
      registryRegion("123456789012.dkr.ecr.eu-west-1.amazonaws.com/scvs-composed-environments"),
    ).toThrow(ImageError);
  });

  it("refuses a non-ECR registry", () => {
    expect(() => registryRegion("docker.io")).toThrow(ImageError);
    expect(() => registryRegion("")).toThrow(ImageError);
  });

  it("reports ecr_auth_failed with the offending registry in context", () => {
    // The reason code travels to the receipt and becomes `Environment.errorCode`, so it has to be the
    // machine-readable one rather than a bare message.
    try {
      registryRegion("not-a-registry");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageError);
      expect((error as ImageError).reason).toBe("ecr_auth_failed");
      expect((error as ImageError).context).toEqual({ registry: "not-a-registry" });
    }
  });
});

describe("reportsExpectedRev", () => {
  // The rev half of a recorded `cliver`.
  const REV = "5a7c5fe76530bf4248477ac812fc757146b98cc4";

  it("finds the commit in the CLI's own version output", () => {
    expect(reportsExpectedRev(`stellar 27.0.0 (${REV})`, REV)).toBe(true);
    expect(reportsExpectedRev(`stellar 27.0.0\ncommit: ${REV}\n`, REV)).toBe(true);
  });

  it("refuses a rev that is only a prefix of the reported one", () => {
    // A truncated commit hash that happens to prefix the real one would otherwise accept a different build as
    // the recorded one.
    expect(reportsExpectedRev(`stellar 27.0.0 (${REV})`, REV.slice(0, 12))).toBe(false);
  });

  it("refuses a rev that is a suffix of a longer hash", () => {
    expect(reportsExpectedRev(`stellar 27.0.0 (ab${REV})`, REV)).toBe(false);
  });

  it("accepts a git-describe rev, which is not hex", () => {
    expect(reportsExpectedRev("stellar 26.0.0 (v20.0.0-833-gd6f4b2a)", "v20.0.0-833-gd6f4b2a")).toBe(
      true,
    );
  });

  it("refuses a different commit of the same version", () => {
    expect(
      reportsExpectedRev(`stellar 27.0.0 (${REV})`, "93e1b1671f14830662766c005138b19095fe9307"),
    ).toBe(false);
  });

  it("refuses an empty rev and empty output", () => {
    expect(reportsExpectedRev(`stellar 27.0.0 (${REV})`, "")).toBe(false);
    expect(reportsExpectedRev("", REV)).toBe(false);
    expect(reportsExpectedRev("command not found", REV)).toBe(false);
  });
});

describe("reportedVersion", () => {
  it("preserves later lines carrying stellar-cli's revision", async () => {
    const output =
      "stellar 27.0.0\ncommit: 5a7c5fe76530bf4248477ac812fc757146b98cc4\n";
    const runner = async (): Promise<CommandResult> => ({
      command: ["docker"],
      exit_code: 0,
      stdout: output,
      stderr: "",
      timed_out: false,
    });

    await expect(
      reportedVersion(
        { environmentId: "environment-id", timeoutMs: 1_000 },
        ["stellar", "version"],
        "stellar",
        runner,
      ),
    ).resolves.toBe(output.trim());
  });

  it("probes the binary via --entrypoint, not as a command the image's entrypoint would swallow", async () => {
    // Template v3 declares `ENTRYPOINT ["stellar"]` to mirror the official image.
    const calls: string[][] = [];
    const runner = async (command: string[]): Promise<CommandResult> => {
      calls.push(command);
      return { command, exit_code: 0, stdout: "rustc 1.97.1 (8bab26f4f 2026-07-14)\n", stderr: "", timed_out: false };
    };

    await reportedVersion(
      { environmentId: "environment-id", timeoutMs: 1_000 },
      ["rustc", "--version"],
      "rustc",
      runner,
    );

    const argv = calls[0]!;
    // The binary is the entrypoint; only its arguments follow the image reference.
    expect(argv).toContain("--entrypoint");
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("rustc");
    const imageIndex = argv.findIndex((token) => token.startsWith("scvs-composed:"));
    expect(argv.slice(imageIndex + 1)).toEqual(["--version"]);
    // And the probe must not be reachable as `<entrypoint> rustc …`.
    expect(argv.slice(imageIndex + 1)).not.toContain("rustc");
  });
});

describe("isImmutableTagConflict", () => {
  // The recovery path this gates adopts an image already in ECR as this environment's own.
  const push = (stderr: string): { stdout: string; stderr: string } => ({ stdout: "", stderr });

  it("recognises what ECR actually says when the tag is taken on an immutable repository", () => {
    expect(
      isImmutableTagConflict(
        push(
          "tag invalid: The image tag 'abc123' already exists in the " +
            "'scvs-composed-environments' repository and cannot be overwritten because the " +
            "repository is immutable.",
        ),
      ),
    ).toBe(true);
  });

  it("recognises the API exception name, whichever surface reports it", () => {
    expect(isImmutableTagConflict(push("ImageTagAlreadyExistsException: ..."))).toBe(true);
  });

  it("★ does not fire on an ordinary push failure", () => {
    expect(isImmutableTagConflict(push("denied: User is not authorized to perform: ecr:PutImage"))).toBe(
      false,
    );
    expect(isImmutableTagConflict(push("error: failed to push: net/http: TLS handshake timeout"))).toBe(
      false,
    );
    expect(isImmutableTagConflict(push(""))).toBe(false);
  });

  it("★ needs both markers, not either one", () => {
    // "already exists" alone is ordinary layer-push chatter; "immutable" alone can come from an unrelated
    // message about repository settings.
    expect(isImmutableTagConflict(push("layer already exists"))).toBe(false);
    expect(isImmutableTagConflict(push("repository is immutable"))).toBe(false);
  });
});

/**
 * The architecture is recorded on the `Environment` row so dispatch can pick a Batch queue whose hosts can
 * actually run the image, *without* probing our private ECR.
 */
describe("parseInspectedImage", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const REPO = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments";

  it("reads both facts from one inspect", () => {
    expect(parseInspectedImage(`${REPO}@${DIGEST}\tarm64\n`)).toEqual({
      repoDigest: `${REPO}@${DIGEST}`,
      digest: DIGEST,
      architecture: "arm64",
    });
  });

  it("reads amd64 as readily as arm64 — the default must never be the only thing that works", () => {
    expect(parseInspectedImage(`${REPO}@${DIGEST}\tamd64`).architecture).toBe("amd64");
  });

  it("★ records no architecture for one we have no queue for, and still yields the digest", () => {
    // `uname -m`'s spellings land here too, which is why the format asks Docker for the image config's own
    // value rather than the host's.
    for (const reported of ["riscv64", "aarch64", "x86_64", "", "   "]) {
      const parsed = parseInspectedImage(`${REPO}@${DIGEST}\t${reported}`);
      expect(parsed.architecture).toBeUndefined();
      expect(parsed.digest).toBe(DIGEST);
    }
  });

  it("records no architecture when the field is missing entirely", () => {
    // An older daemon, or a format string that lost its second field: the digest still has to work.
    const parsed = parseInspectedImage(`${REPO}@${DIGEST}`);
    expect(parsed).toEqual({ repoDigest: `${REPO}@${DIGEST}`, digest: DIGEST });
  });

  it("reports no digest — the caller's hard failure — for an unusable one, whatever the architecture", () => {
    for (const line of [`${REPO}:latest\tarm64`, `\tarm64`, `${REPO}@sha256:nothex\tarm64`]) {
      expect(parseInspectedImage(line).digest).toBeUndefined();
    }
  });

  it("does not mistake a digest for an architecture when the tab is absent", () => {
    // Splitting on whitespace instead of the tab would put `arm64` in the digest field or vice versa.
    expect(parseInspectedImage(`${REPO}@${DIGEST} arm64`).digest).toBeUndefined();
  });
});
