/** Prints the drift ledger once, after every worker has finished. */
const fs = require("node:fs");

module.exports = async function printDrift() {
  const logPath = process.env.SCVS_E2E_DRIFT_LOG;
  if (!logPath || !fs.existsSync(logPath)) return;

  const entries = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);

  if (entries.length === 0) return;

  const byGap = new Map();
  for (const entry of entries) {
    const list = byGap.get(entry.gap) ?? [];
    list.push(entry);
    byGap.set(entry.gap, list);
  }

  process.stdout.write(
    `\n── TRD conformance drift: ${entries.length} observation(s) across ${byGap.size} gap(s) ──\n` +
      `   These are cases that ran, reached the endpoint, and found the implementation behaving\n` +
      `   differently from the rule the case cites. They are recorded, not failed. Re-run with\n` +
      `   SCVS_E2E_STRICT_TRD=1 to fail on them.\n\n`
  );

  for (const [gap, list] of [...byGap.entries()].sort()) {
    process.stdout.write(`   ${gap}  (${list.length})\n`);
    for (const entry of list) {
      process.stdout.write(`     · ${entry.case}: ${entry.detail}\n`);
    }
    process.stdout.write("\n");
  }
  process.stdout.write(`   Full ledger: ${logPath}\n\n`);
};
