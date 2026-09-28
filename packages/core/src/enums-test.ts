import assert from "node:assert/strict";
import {
  failureReasons,
  jobStatuses,
  toWireVerificationStatus,
  verdicts,
  verificationStatuses,
  type VerificationStatus,
} from "./enums.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function reachableStatuses(): Set<VerificationStatus> {
  const reached = new Set<VerificationStatus>();
  for (const status of jobStatuses) {
    for (const reason of [...failureReasons, null, undefined] as const) {
      for (const verdict of [...verdicts, null, undefined] as const) {
        reached.add(toWireVerificationStatus(status, reason, verdict));
      }
    }
  }
  return reached;
}

test("every declared wire status has a producer", () => {
  const reached = reachableStatuses();
  const orphaned = verificationStatuses.filter((status) => !reached.has(status));
  assert.deepEqual(
    orphaned,
    [],
    `declared in verificationStatuses but unreachable from toWireVerificationStatus: ${orphaned.join(", ")}. ` +
      "Either give it a producer or remove it — a value the server cannot send is a promise to every client that reads the enum.",
  );
});

test("the mapper invents no status the enum does not declare", () => {
  const undeclared = [...reachableStatuses()].filter(
    (status) => !(verificationStatuses as readonly string[]).includes(status),
  );
  assert.deepEqual(undeclared, []);
});

test("source_hash_mismatch is not a wire status", () => {
  assert.equal((verificationStatuses as readonly string[]).includes("source_hash_mismatch"), false);
});

test("a source-unreachable failure is what a hash mismatch reaches the wire as", () => {
  assert.equal(toWireVerificationStatus("failed", "source_unreachable"), "source_unavailable");
});

test("the mapper still distinguishes a mismatch from a verified result", () => {
  assert.equal(toWireVerificationStatus("published", null, "mismatched"), "mismatch");
  assert.equal(toWireVerificationStatus("published", null, "verified"), "verified");
  assert.equal(toWireVerificationStatus("evaluated", null, "mismatched"), "mismatch");
});

test("a publication still in progress is `running`, never a verdict", () => {
  assert.equal(toWireVerificationStatus("publishing"), "running");
  assert.equal(toWireVerificationStatus("publish_pending"), "running");
});

console.log("enums: all cases passed");
