import { recordedCommands } from "@scvs/core/process";
import { redactAll, redactCommand } from "./redact.js";

export const MAX_BUILD_LOG_BYTES = 256 * 1024;

const TRUNCATION_NOTICE = "\n\n[log truncated: the build produced more output than this verifier retains]\n";

export function assembleBuildLog(): string | undefined {
  const commands = recordedCommands();
  if (commands.length === 0) return undefined;

  const sections = commands.map((command) => {
    const header = `$ ${redactCommand(command.command).join(" ")}`;
    const status = command.timed_out
      ? "[timed out]"
      : `[exit ${command.exit_code ?? "null"}]`;
    // Redacted per section with the log's own ceiling, so redaction's default input bound cannot cut a large stage.
    const body = [command.stdout, command.stderr, command.error]
      .filter((part): part is string => Boolean(part))
      .map((part) => redactAll(part, MAX_BUILD_LOG_BYTES))
      .join("");
    return `${header}\n${body}${body.endsWith("\n") ? "" : "\n"}${status}\n`;
  });

  const whole = sections.join("\n");
  if (Buffer.byteLength(whole) <= MAX_BUILD_LOG_BYTES) return whole;

  const budget = MAX_BUILD_LOG_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
  const tail = Buffer.from(whole, "utf8").subarray(-budget).toString("utf8");
  return `${TRUNCATION_NOTICE}${tail}`;
}
