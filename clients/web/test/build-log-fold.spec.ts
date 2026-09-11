import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  foldBuildLog,
  foldedLineCount,
} from "@/features/verification/utils/build-log.util";

/**
 * Kept as a fixture rather than synthesised: the whole point of the folding is the shape of an actual `cargo
 * vendor` + `docker pull` run, and a hand-written sample would only ever contain the cases this code already
 * handles.
 */
const REAL_LOG = readFileSync(
  join(process.cwd(), "test/fixtures/dev-job-9cfbfecd.buildlog.txt"),
  "utf8",
);

describe("the build log folds its boilerplate and nothing else", () => {
  // A build log is evidence. "Shorter" may only ever mean "folded".
  test("every original line survives, in order", () => {
    const rebuilt = foldBuildLog(REAL_LOG)
      .map((segment) => segment.text)
      .join("\n");

    const strip = (text: string) =>
      text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .join("\n");

    expect(strip(rebuilt)).toBe(strip(REAL_LOG));
  });

  test("hides the bulk of it — the measurement this exists for", () => {
    const segments = foldBuildLog(REAL_LOG);
    const total = REAL_LOG.split("\n").length;
    const folded = foldedLineCount(segments);

    // Measured at 428/564 when this was written. Pinned as a floor, not an equality: a pattern that stops
    // matching should fail here rather than quietly stop saving anything.
    expect(folded / total).toBeGreaterThan(0.7);
  });

  test("folds each kind of bookkeeping under its own summary", () => {
    const labels = foldBuildLog(REAL_LOG)
      .filter((segment) => segment.kind === "folded")
      .map((segment) => (segment.kind === "folded" ? segment.label : ""));

    expect(labels).toContain("Downloaded 186 crates");
    expect(labels).toContain("Vendored 186 crates into the offline registry");
    expect(labels).toContain("Compiled 78 crates");
    expect(labels.some((label) => /^Pulled the build image/.test(label))).toBe(true);
  });

  // `docker login` is the verifier authenticating to its own ECR, but "your password will be stored
  // unencrypted" at the top of your own job's log reads as something having happened to you.
  test("does not open on the verifier's registry login", () => {
    const [first] = foldBuildLog(REAL_LOG);
    expect(first.kind).toBe("folded");
    if (first.kind === "folded") {
      expect(first.label).toBe("Authenticated to the verifier's image registry");
      expect(first.text).toMatch(/password will be stored unencrypted/);
    }
  });

  test("the signal lines stay inline", () => {
    const inline = foldBuildLog(REAL_LOG)
      .filter((segment) => segment.kind === "lines")
      .map((segment) => segment.text)
      .join("\n");

    expect(inline).toMatch(/Finished `release` profile \[optimized\] target\(s\) in 47\.48s/);
    expect(inline).toMatch(
      /Wasm Hash: 7944a96d512f6e51532687811cc0c932505b0c051be9d351f5332739d70f753c/,
    );
    expect(inline).toMatch(/✅ Build Complete/);
    expect(inline).toMatch(/Exported Functions: 23 found/);
  });
});

describe("folding is conservative about short runs", () => {
  test("a run too short to be worth a disclosure stays inline", () => {
    const log = ["$ cargo build", "   Compiling foo v1.0.0", "   Compiling bar v2.0.0", "done"].join(
      "\n",
    );
    const segments = foldBuildLog(log);

    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("lines");
  });

  test("an empty log folds to nothing rather than to an empty block", () => {
    expect(foldBuildLog("")).toEqual([]);
  });

  /**
   * cargo emits blank lines mid-sequence. Letting one end a run would split 186 vendored crates into two runs
   * of ~90 and fold neither usefully.
   */
  test("a blank line inside a run does not split it", () => {
    const log = [
      "   Vendoring a v1.0.0 (x) to /vendor/a",
      "   Vendoring b v1.0.0 (x) to /vendor/b",
      "",
      "   Vendoring c v1.0.0 (x) to /vendor/c",
      "   Vendoring d v1.0.0 (x) to /vendor/d",
      "[exit 0]",
    ].join("\n");

    const folded = foldBuildLog(log).filter((segment) => segment.kind === "folded");
    expect(folded).toHaveLength(1);
    if (folded[0].kind === "folded") {
      expect(folded[0].label).toBe("Vendored 4 crates into the offline registry");
    }
  });
});
