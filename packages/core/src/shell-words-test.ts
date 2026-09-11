import assert from "node:assert/strict";
import { escapeShellWord, splitShellWords, unescapeShellWord } from "./shell-words.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("splitShellWords: splits on whitespace, respecting quotes", () => {
  assert.deepEqual(splitShellWords("--locked --features a,b"), { ok: true, words: ["--locked", "--features", "a,b"] });
  assert.deepEqual(splitShellWords("--manifest-path='contracts/with space/Cargo.toml'"), {
    ok: true,
    words: ["--manifest-path=contracts/with space/Cargo.toml"],
  });
});

test("splitShellWords: refuses an unterminated quote", () => {
  const result = splitShellWords("'unterminated");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "unterminated_quote");
});

test("unescapeShellWord: refuses more than one shell word", () => {
  const result = unescapeShellWord("a b");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "multiple_words");
});

test("unescapeShellWord: refuses an empty entry", () => {
  const result = unescapeShellWord("");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "empty");
});

test("unescapeShellWord: strips a single-quoted wrapper from one entry", () => {
  assert.deepEqual(unescapeShellWord("'--manifest-path=a b/Cargo.toml'"), {
    ok: true,
    word: "--manifest-path=a b/Cargo.toml",
  });
});

test("escapeShellWord: leaves a safe word untouched and quotes an unsafe one", () => {
  assert.equal(escapeShellWord("--package=hello-contract"), "--package=hello-contract");
  assert.equal(escapeShellWord("has space"), "'has space'");
  assert.equal(escapeShellWord("it's"), "'it'\\''s'");
});

console.log("shell-words: all cases passed");
