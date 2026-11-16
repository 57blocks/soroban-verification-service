import { readFile, rm } from "node:fs/promises";
import { runCommand, type CommandResult } from "@scvs/core/process";
import { dockerCliOptions } from "./docker-env.js";

const REMOVE_TIMEOUT_MS = 60_000;

/**
 * Runs one sandbox stage's `docker run`. A timeout kills only the docker client, so the container itself is
 * removed before this returns: no untrusted process may outlive its stage or race the job's cleanup.
 */
export async function runSandboxContainer(
  command: string[],
  options: { cidFile: string; timeout_ms: number },
): Promise<CommandResult & { containerRemoved?: boolean }> {
  const run = command.indexOf("run");
  if (command[0] !== "docker" || run < 0) throw new Error(`not a docker run command: ${command.slice(0, 2).join(" ")}`);
  await rm(options.cidFile, { force: true });
  const argv = [...command.slice(0, run + 1), "--cidfile", options.cidFile, ...command.slice(run + 1)];

  const result = await runCommand(argv, { ...dockerCliOptions(), timeout_ms: options.timeout_ms });
  const containerId = (await readFile(options.cidFile, "utf8").catch(() => "")).trim();
  await rm(options.cidFile, { force: true });
  if (!result.timed_out || !containerId) return result;

  const removed = await runCommand(["docker", "rm", "--force", containerId], {
    ...dockerCliOptions(),
    timeout_ms: REMOVE_TIMEOUT_MS,
    mirrorOutput: false,
  });
  return { ...result, containerRemoved: removed.exit_code === 0 };
}
