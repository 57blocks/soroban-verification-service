export type ShellWordErrorReason = "unterminated_quote" | "multiple_words" | "empty";

export type ShellWordResult =
  | { ok: true; word: string }
  | { ok: false; reason: ShellWordErrorReason; detail: string };

export type ShellWordsResult =
  | { ok: true; words: string[] }
  | { ok: false; reason: ShellWordErrorReason; detail: string };

export function unescapeShellWord(entry: string): ShellWordResult {
  const split = splitShellWords(entry);
  if (!split.ok) return split;
  if (split.words.length === 0) {
    return { ok: false, reason: "empty", detail: "Shell entry is empty." };
  }
  if (split.words.length !== 1) {
    return {
      ok: false,
      reason: "multiple_words",
      detail: `Expected one shell word, got ${split.words.length}.`,
    };
  }
  return { ok: true, word: split.words[0] };
}

export function splitShellWords(line: string): ShellWordsResult {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let hadChars = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      } else {
        current += char;
      }
      hadChars = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else if (char === "\\") {
        const next = line[index + 1];
        if (next === undefined) {
          current += char;
        } else if (["$", "`", '"', "\\", "\n"].includes(next)) {
          current += next;
          index += 1;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      hadChars = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hadChars = true;
      continue;
    }
    if (char === "\\") {
      const next = line[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
        hadChars = true;
        continue;
      }
      current += char;
      hadChars = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hadChars) {
        words.push(current);
        current = "";
        hadChars = false;
      }
      continue;
    }
    current += char;
    hadChars = true;
  }

  if (quote) {
    return {
      ok: false,
      reason: "unterminated_quote",
      detail: `Unterminated ${quote} quote in shell entry.`,
    };
  }
  if (hadChars) words.push(current);
  return { ok: true, words };
}

export function escapeShellWord(word: string): string {
  if (word.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}
