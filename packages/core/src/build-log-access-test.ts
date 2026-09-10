import assert from "node:assert/strict";
import {
  buildLogTokenMatches,
  hashBuildLogToken,
  isBuildLogTokenShaped,
  mintBuildLogToken,
} from "./build-log-token.js";
import { sanitizeTerminalOutput } from "./sanitize-terminal.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

/** The two primitives behind build-log-access design.md BL-1 and BL-4. */

const ESC = "\u001b";

test("a minted token is 256 bits of base64url, and never repeats", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => mintBuildLogToken()));
  assert.equal(tokens.size, 200);
  for (const token of tokens) {
    assert.ok(isBuildLogTokenShaped(token), `not token-shaped: ${token}`);
    assert.equal(Buffer.from(token, "base64url").length, 32);
  }
});

test("the stored value is a digest, and the token is not derivable from it", () => {
  const token = mintBuildLogToken();
  const stored = hashBuildLogToken(token);

  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.ok(!stored.includes(token));
  // The digest is what the row holds; nothing about it is the token.
  assert.notEqual(stored, token);
});

test("the right token matches and every wrong one does not", () => {
  const token = mintBuildLogToken();
  const stored = hashBuildLogToken(token);

  assert.equal(buildLogTokenMatches(token, stored), true);
  assert.equal(buildLogTokenMatches(mintBuildLogToken(), stored), false);
  // A job that never minted one cannot be unlocked by anything, including the empty string.
  assert.equal(buildLogTokenMatches(token, undefined), false);
  assert.equal(buildLogTokenMatches("", undefined), false);
});

test("a stored value that is not a digest matches nothing, rather than throwing", () => {
  // timingSafeEqual throws on a length mismatch, which would turn a corrupt row into a 500.
  for (const corrupt of ["", "not-hex", "ab", "f".repeat(63), "f".repeat(65)]) {
    assert.equal(buildLogTokenMatches(mintBuildLogToken(), corrupt), false);
  }
});

test("a token of the wrong shape is rejected before it is hashed", () => {
  for (const wrong of ["", "short", "!".repeat(43), `${mintBuildLogToken()}x`, "a".repeat(4096)]) {
    assert.equal(isBuildLogTokenShaped(wrong), false);
  }
});

/** BL-4 — the log is attacker-controlled content, and this is the hostile payload the AC asks for. */
test("terminal control sequences are stripped from captured output", () => {
  const hostile: [string, string, string][] = [
    ["OSC 8 hyperlink", `${ESC}]8;;https://evil.test${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    ["OSC 0 window title, BEL-terminated", `${ESC}]0;pwned\u0007after`, "after"],
    ["CSI erase + cursor home", `${ESC}[2J${ESC}[1;1Hoverwritten`, "overwritten"],
    ["SGR colour", `${ESC}[31mred${ESC}[0m`, "red"],
    ["DCS sixel", `${ESC}Pqsixel-payload${ESC}\\tail`, "tail"],
    ["SS3", `${ESC}OPkey`, "key"],
    ["backspace overstrike", "safe\u0008\u0008\u0008\u0008evil", "safeevil"],
    ["DEL and a C1 CSI", "a\u007fb\u009b31m", "ab31m"],
    ["unterminated OSC swallows to the end", `${ESC}]0;no-terminator`, ""],
  ];

  for (const [name, input, expected] of hostile) {
    assert.equal(sanitizeTerminalOutput(input), expected, name);
  }
});

test("ordinary output survives, whitespace included", () => {
  const log = "   Compiling soroban-sdk v22.0.0\n   Finished `release` profile\r\n\tindented\n";
  assert.equal(sanitizeTerminalOutput(log), log);
});

test("sanitising is idempotent, so a second pass cannot change a served body", () => {
  const once = sanitizeTerminalOutput(`${ESC}[31merror[E0432]${ESC}[0m: unresolved import`);
  assert.equal(sanitizeTerminalOutput(once), once);
  assert.equal(once, "error[E0432]: unresolved import");
});

console.log("Build-log access: 8 cases passed");
