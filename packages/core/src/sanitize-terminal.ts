/**
 * Strips terminal control sequences from captured output (build-log-access design.md BL-4).
 *
 * The log is attacker-controlled by construction — it is whatever a submitter's source made the compiler
 * print. React escapes HTML for the console, but nothing protects a reader who `curl`s the route, an SDK
 * consumer, or the terminal a log is pasted into: an OSC sequence can retitle a window or drive a clipboard
 * write, and CSI can rewrite what is already on screen. Applied on the way OUT of the API rather than at
 * capture, so it covers every log already in the bucket as well as every future one.
 */

/**
 * ESC-introduced sequences. Order matters — the string-terminated forms come first so the bare two-character
 * alternative cannot claim their introducer:
 *
 *   OSC             `ESC ]` … `BEL` | `ST` | end of input
 *   DCS/SOS/PM/APC  `ESC P|X|^|_` … `ST` | end of input
 *   CSI             `ESC [` params intermediates final
 *   two-character   `ESC` + one of `@`–`_` (SS2, SS3, RIS and the rest)
 */
const ESCAPE_SEQUENCES = new RegExp(
  [
    "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\|$)",
    "\\u001b[PX^_][\\s\\S]*?(?:\\u001b\\\\|$)",
    "\\u001b\\[[0-?]*[ -/]*[@-~]",
    // SS2/SS3 take the NEXT character from an alternate set, so the character travels with them —
    // stripping the introducer alone would leave `ESC O P` (F1) showing as a literal `P`.
    "\\u001b[NO][\\s\\S]",
    "\\u001b[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

/**
 * What is left once the sequences are gone: C0 except tab, newline and carriage return; DEL; and the C1
 * block, which a UTF-8 decoder can produce from a two-byte sequence and which some terminals still act on.
 */
const LONE_CONTROLS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]", "g");

export function sanitizeTerminalOutput(value: string): string {
  return value.replace(ESCAPE_SEQUENCES, "").replace(LONE_CONTROLS, "");
}
