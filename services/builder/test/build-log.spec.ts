import {
  MAX_BUILD_LOG_BYTES,
  assembleBuildLog,
} from "../src/modules/builder/build-log.js";
import {
  recordedCommands,
  resetRecordedCommands,
  runCommand,
} from "@scvs/core/process";

beforeEach(() => resetRecordedCommands());
afterAll(() => resetRecordedCommands());

const echo = (text: string) => runCommand(["node", "-e", `process.stdout.write(${JSON.stringify(text)})`], {
  mirrorOutput: false,
});

const emit = (bytes: number, char = "x") =>
  runCommand(["node", "-e", `process.stdout.write("${char}".repeat(${bytes}))`], {
    mirrorOutput: false,
  });

describe("the capture sink", () => {
  it("records every command that ran, in order", async () => {
    await echo("first");
    await echo("second");

    expect(recordedCommands()).toHaveLength(2);
    expect(recordedCommands()[0]!.stdout).toBe("first");
    expect(recordedCommands()[1]!.stdout).toBe("second");
  });

  it("records a command that failed, which is when the log matters most", async () => {
    await runCommand(["node", "-e", "process.stderr.write('boom'); process.exit(3)"], {
      mirrorOutput: false,
    });

    const [recorded] = recordedCommands();
    expect(recorded?.exit_code).toBe(3);
    expect(recorded?.stderr).toBe("boom");
  });

  it("a command that opts out of recording leaves no trace in the sink", async () => {
    await runCommand(["node", "-e", "process.stdout.write('must-not-appear')"], {
      mirrorOutput: false,
      record: false,
    });

    expect(recordedCommands()).toHaveLength(0);
  });
});

describe("assembleBuildLog", () => {
  it("returns undefined when nothing ran, rather than an empty log", async () => {
    expect(assembleBuildLog()).toBeUndefined();
  });

  it("carries the command line, the output and the exit status of each stage", async () => {
    await echo("hello from the build");
    const log = assembleBuildLog()!;

    expect(log).toContain("$ node -e");
    expect(log).toContain("hello from the build");
    expect(log).toContain("[exit 0]");
  });

  it("★ keeps output far past excerpt()'s 1200-char limit", async () => {
    await emit(50_000, "x");

    expect(assembleBuildLog()!).toContain("x".repeat(50_000));
  });

  it("redacts secrets in the captured output", async () => {
    await echo("fetching https://example.test/src.tar.gz?X-Amz-Signature=abcdef123456\n");
    const log = assembleBuildLog()!;

    expect(log).toContain("https://example.test/src.tar.gz?<redacted>");
    expect(log).not.toContain("abcdef123456");
  });

  it("redacts the command line too, which carries the presigned source URL", async () => {
    await runCommand(
      ["node", "-e", "0", "--url=https://example.test/o?X-Amz-Security-Token=SECRETVALUE"],
      { mirrorOutput: false },
    );

    expect(assembleBuildLog()!).not.toContain("SECRETVALUE");
  });
});

describe("the fixtures themselves stay portable", () => {
  it("★ never puts a large payload in a child's argv", () => {
    const MAX_ARG_STRLEN = 131_072;
    const commands = [
      ["node", "-e", `process.stdout.write("y".repeat(${MAX_BUILD_LOG_BYTES}))`],
      ["node", "-e", `process.stdout.write("x".repeat(50000))`],
    ];

    for (const command of commands) {
      for (const argument of command) {
        expect(Buffer.byteLength(argument)).toBeLessThan(MAX_ARG_STRLEN);
      }
    }
  });
});

describe("assembleBuildLog — the ceiling", () => {
  it("★ truncates from the front, so the failing tail survives", async () => {
    await emit(MAX_BUILD_LOG_BYTES, "E");
    await runCommand(["node", "-e", "process.stderr.write('the real failure'); process.exit(1)"], {
      mirrorOutput: false,
    });

    const log = assembleBuildLog()!;
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(MAX_BUILD_LOG_BYTES);
    expect(log).toContain("the real failure");
    expect(log).toContain("[exit 1]");
    expect(log).toContain("log truncated");
  });

  it("does not truncate a log that fits", async () => {
    await echo("small");

    expect(assembleBuildLog()!).not.toContain("log truncated");
  });

  it("★ a single oversized stage is bounded by the log's ceiling, not by MAX_REDACTED_INPUT", async () => {
    await emit(200_000, "y");
    const log = assembleBuildLog()!;

    expect(log.length).toBeGreaterThan(64 * 1024);
  });
});
