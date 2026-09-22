import { recordedCommands } from "@scvs/core/process";
import { redactAll, redactCommand } from "./redact.js";

/** The sink records the real thing; this file bounds and redacts it. */

/** The ceiling on the assembled log. */
export const MAX_BUILD_LOG_BYTES = 256 * 1024;

/** Marks a log the ceiling cut, so a reader never mistakes truncation for the end of the build. */
const TRUNCATION_NOTICE = "\n\n[log truncated: the build produced more output than this verifier retains]\n";

/**
 * The log for this run, or `undefined` when nothing ran (no command executed, so no output — an empty string
 * would claim a build happened and produced silence).
 */
export function assembleBuildLog(): string | undefined {
  const commands = recordedCommands();
  if (commands.length === 0) return undefined;

  const sections = commands.map((command) => {
    const header = `$ ${redactCommand(command.command).join(" ")}`;
    const status = command.timed_out
      ? "[timed out]"
      : `[exit ${command.exit_code ?? "null"}]`;
    // Redacted per section with the log's own ceiling, so a single large stage is not silently cut at
    // `MAX_REDACTED_INPUT` before the log's own bound is even consulted.
    const body = [command.stdout, command.stderr, command.error]
      .filter((part): part is string => Boolean(part))
      .map((part) => redactAll(part, MAX_BUILD_LOG_BYTES))
      .join("");
    return `${header}\n${body}${body.endsWith("\n") ? "" : "\n"}${status}\n`;
  });

  const whole = sections.join("\n");
  if (Buffer.byteLength(whole) <= MAX_BUILD_LOG_BYTES) return whole;

  // Cut on bytes, not characters, because the ceiling is a byte ceiling — and from the front, so the failing
  // tail survives.
  const budget = MAX_BUILD_LOG_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
  const tail = Buffer.from(whole, "utf8").subarray(-budget).toString("utf8");
  return `${TRUNCATION_NOTICE}${tail}`;
}
