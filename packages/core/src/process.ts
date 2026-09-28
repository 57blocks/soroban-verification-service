/** Node-only: not exported from the barrel; import `@scvs/core/process`. */
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

const recorded: CommandResult[] = [];

const MAX_RECORDED_COMMANDS = 256;

export function recordedCommands(): readonly CommandResult[] {
  return recorded;
}

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
    /** Never logged or mirrored. */
    stdin?: string;
    record?: boolean;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

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

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // EPIPE when the child exits before reading stdin; unhandled, it would crash the process.
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
      // Recorded before resolving, so a caller that throws on the result cannot lose it.
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
