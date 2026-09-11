import { rejectedBuildArgument } from "../src/modules/builder/argument-policy.js";

/** The submitter sees 'your contract does not build' about a contract that built fine at the time."* */

const ARGV = [
  "docker",
  "run",
  "--rm",
  "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:abc",
  "contract",
  "build",
  "--locked",
  "--manifest-path",
  "/source/Cargo.toml",
  "--out-dir",
  "/out",
];

/** The CLI's real output, verbatim. */
const CLAP4_STDERR = [
  "error: unexpected argument '--locked' found",
  "",
  "Usage: stellar contract build [OPTIONS]",
  "",
  "For more information, try '--help'.",
].join("\n");

describe("rejectedBuildArgument — the incident", () => {
  it("names the recorded flag the CLI refused, and whose it is", () => {
    expect(
      rejectedBuildArgument({
        stderr: CLAP4_STDERR,
        argv: ARGV,
        replayedBldopts: ["--locked"],
      }),
    ).toEqual({ flag: "--locked", origin: "recorded_bldopt" });
  });

  it("reads clap 3's wording too, since the image's CLI version is what varies", () => {
    expect(
      rejectedBuildArgument({
        stderr: "error: Found argument '--locked' which wasn't expected, or isn't valid in this context",
        argv: ARGV,
        replayedBldopts: ["--locked"],
      }),
    ).toEqual({ flag: "--locked", origin: "recorded_bldopt" });
  });

  it("accepts double-quoted output as readily as single-quoted", () => {
    expect(
      rejectedBuildArgument({
        stderr: 'error: unexpected argument "--locked" found',
        argv: ARGV,
        replayedBldopts: ["--locked"],
      })?.flag,
    ).toBe("--locked");
  });
});

describe("rejectedBuildArgument — never guesses", () => {
  // Ordinary compile failures are the overwhelming majority of build failures, and not one of them may be
  // relabelled as a rejected build option.
  it("says nothing about an ordinary compile failure", () => {
    const compileError = [
      "error[E0425]: cannot find value `foo` in this scope",
      "  --> src/lib.rs:12:5",
      "error: could not compile `reflector-pulse-contract` (lib) due to 1 previous error",
    ].join("\n");

    expect(
      rejectedBuildArgument({ stderr: compileError, argv: ARGV, replayedBldopts: ["--locked"] }),
    ).toBeUndefined();
  });

  it("★ says nothing about a flag we did not issue, however clearly the text names one", () => {
    // Compare against what is actually there, never against what we expect — the same discipline the
    // composition gate's `assertRuntimeSurfaceMatchesOfficial` follows.
    expect(
      rejectedBuildArgument({
        stderr: "error: unexpected argument '--frobnicate' found",
        argv: ARGV,
        replayedBldopts: ["--locked"],
      }),
    ).toBeUndefined();
  });

  it("says nothing when the captured token is not a flag at all", () => {
    expect(
      rejectedBuildArgument({
        stderr: "error: unexpected argument 'build' found",
        argv: ARGV,
        replayedBldopts: [],
      }),
    ).toBeUndefined();
  });

  it("says nothing about a clean build", () => {
    expect(
      rejectedBuildArgument({ stderr: "", argv: ARGV, replayedBldopts: ["--locked"] }),
    ).toBeUndefined();
  });
});

describe("rejectedBuildArgument — origin decides who owns the failure", () => {
  it("calls a flag we added ours, not the recipe's", () => {
    // `--out-dir` is in ADDED_ARGUMENTS, not in the recorded recipe.
    expect(
      rejectedBuildArgument({
        stderr: "error: unexpected argument '--out-dir' found",
        argv: ARGV,
        replayedBldopts: ["--locked"],
      }),
    ).toEqual({ flag: "--out-dir", origin: "verifier_added" });
  });

  it("matches a recorded `--flag=value` against a rejection naming the bare flag", () => {
    expect(
      rejectedBuildArgument({
        stderr: "error: unexpected argument '--features' found",
        argv: [...ARGV, "--features=a,b"],
        replayedBldopts: ["--features=a,b"],
      }),
    ).toEqual({ flag: "--features", origin: "recorded_bldopt" });
  });
});

describe("rejectedBuildArgument — the value never travels", () => {
  // This flag reaches SandboxDiagnostics and, through `rebuildFailureDetail`, the public job-status endpoint
  // and SSE.
  it("strips everything after the first `=`", () => {
    const rejected = rejectedBuildArgument({
      stderr: "error: unexpected argument '--env=TOKEN=abc123' found",
      argv: [...ARGV, "--env=TOKEN=abc123"],
      replayedBldopts: ["--env=TOKEN=abc123"],
    });

    expect(rejected).toEqual({ flag: "--env", origin: "recorded_bldopt" });
    expect(JSON.stringify(rejected)).not.toContain("abc123");
    expect(JSON.stringify(rejected)).not.toContain("TOKEN");
  });
});
