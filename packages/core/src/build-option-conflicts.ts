import { unescapeShellWord } from "./shell-words.js";

const SINGLE_VALUED = new Set(["--package", "--manifest-path", "--profile", "--out-dir"]);
const KEYED = new Set(["--env", "--meta"]);
const TAKES_VALUE = new Set([...SINGLE_VALUED, ...KEYED, "-p"]);

/**
 * Why `bldopt` names one setting twice, or undefined when it does not. Order decides which of two values a
 * build uses, and a recipe published with them reordered would no longer reproduce its bytes.
 */
export function repeatedBuildOption(bldopt: readonly string[] | undefined): string | undefined {
  const tokens: string[] = [];
  for (const raw of bldopt ?? []) {
    const parsed = unescapeShellWord(raw);
    if (parsed.ok) tokens.push(parsed.word);
  }
  const seen = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const inline = /^(--?[A-Za-z][A-Za-z0-9-]*)=(.*)$/s.exec(token);
    let flag = inline?.[1] ?? token;
    let value = inline?.[2];
    if (!inline && TAKES_VALUE.has(flag)) {
      value = tokens[index + 1];
      index += 1;
    }
    if (flag === "-p") flag = "--package";
    let setting: string | undefined;
    if (SINGLE_VALUED.has(flag)) setting = flag;
    else if (KEYED.has(flag) && value !== undefined) setting = `${flag} ${value.split("=", 1)[0]}`;
    if (setting === undefined) continue;
    if (seen.has(setting)) return `bldopt sets ${setting} more than once; give each setting a single value.`;
    seen.add(setting);
  }
  return undefined;
}
