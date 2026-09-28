// Order matters: the string-terminated forms (OSC, DCS/SOS/PM/APC) precede CSI and the two-character form,
// which would otherwise claim their introducer.
const ESCAPE_SEQUENCES = new RegExp(
  [
    "\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\|$)",
    "\\u001b[PX^_][\\s\\S]*?(?:\\u001b\\\\|$)",
    "\\u001b\\[[0-?]*[ -/]*[@-~]",
    // SS2/SS3 consume the next character too.
    "\\u001b[NO][\\s\\S]",
    "\\u001b[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

/** C0 except tab, LF and CR; DEL; and the C1 block, which some terminals still act on. */
const LONE_CONTROLS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]", "g");

export function sanitizeTerminalOutput(value: string): string {
  return value.replace(ESCAPE_SEQUENCES, "").replace(LONE_CONTROLS, "");
}
