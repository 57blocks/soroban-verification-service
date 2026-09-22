/**
 * Running a child process and reading a file's digest — the one implementation.
 *
 * Four services carried a copy of this, and the copies had drifted into a superset and two subsets: `builder`
 * had output mirroring, stdin with its EPIPE guard, and command recording; `composer` had the first two;
 * `orchestrator-svc` and `verification-svc` had neither. This is `builder`'s, which is the superset, so the
 * two richer callers keep their behaviour unchanged and the two plainer ones opt out explicitly.
 *
 * Node-only, and therefore **not exported from this package's barrel** — see `pinned-fetch.ts`, which is kept
 * out for the same reason. Reach it at `@scvs/core/process`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";

export type CommandResult = {
  command: string[];
  cwd?: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  error?: string;
};

/**
 * There is no `result.output` to read: full `CommandResult`s are discarded on the success path, so without this
 * sink the successful builds have no log at all.
 */
const recorded: CommandResult[] = [];

/** How many commands are retained. A rebuild runs on the order of ten. */
const MAX_RECORDED_COMMANDS = 256;

/** The commands run so far, oldest first. Callers must not mutate the result. */
export function recordedCommands(): readonly CommandResult[] {
  return recorded;
}

/** Drops everything recorded. For tests, which share a module instance across cases. */
export function resetRecordedCommands(): void {
  recorded.length = 0;
}

export async function runCommand(
  command: string[],
  options: {
    cwd?: string;
    timeout_ms?: number;
    env?: NodeJS.ProcessEnv;
    mirrorOutput?: boolean;
    /** Written to the child's stdin and closed. Never logged, never mirrored. */
    stdin?: string;
    /** The result is still returned to the caller; only the published log forgets the command ever ran. */
    record?: boolean;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    // Positions 1 and 2 are unconditionally `"pipe"`, so both streams always exist.
    const childStdout = child.stdout as NonNullable<typeof child.stdout>;
    const childStderr = child.stderr as NonNullable<typeof child.stderr>;

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let spawnError: string | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, options.timeout_ms || 120_000);
    timeout.unref();

    // Mirrored to this process's own stdout/stderr (CloudWatch, when running in Batch) in addition to being
    // buffered for CommandResult.
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // A child that exits before reading stdin (a malformed `docker login`, say) makes this write EPIPE.
      });
      child.stdin.end(options.stdin);
    }

    childStdout.on("data", (chunk) => {
      stdout.push(Buffer.from(chunk));
      if (options.mirrorOutput !== false) process.stdout.write(chunk);
    });
    childStderr.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
      if (options.mirrorOutput !== false) process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const result: CommandResult = {
        command,
        cwd: options.cwd,
        exit_code: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timed_out: timedOut,
        error: spawnError,
      };
      // Recorded before resolving, so a caller that throws on the result cannot lose the command that produced
      // it — a failing stage is exactly when the log matters most.
      if (options.record !== false && recorded.length < MAX_RECORDED_COMMANDS) recorded.push(result);
      resolve(result);
    });
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function byteSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
