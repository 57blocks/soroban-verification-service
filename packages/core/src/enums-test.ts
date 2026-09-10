import assert from "node:assert/strict";
import {
  failureReasons,
  jobStatuses,
  toWireVerificationStatus,
  verdicts,
  verificationStatuses,
  type VerificationStatus,
} from "./enums.js";

/** The defect was not that one value was wrong. */

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

/** Every answer the mapper can give, over its entire input space. */
function reachableStatuses(): Set<VerificationStatus> {
  const reached = new Set<VerificationStatus>();
  // `failed` is the only arm that reads `failureReason`, and `published`/`evaluated` the only two that read
  // `verdict`.
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
  // The other direction, and the reason this is not merely a spelling check: `parseDto` validates responses
  // against the enum, so a mapper arm returning an undeclared value fails at the edge.
  const undeclared = [...reachableStatuses()].filter(
    (status) => !(verificationStatuses as readonly string[]).includes(status),
  );
  assert.deepEqual(undeclared, []);
});

test("source_hash_mismatch is not a wire status", () => {
  // A real source-hash mismatch on the async path is the builder's re-hash of bytes it fetched itself, which is
  // `source_unavailable` — "obtained, and could not be trusted".
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
  // verification-svc closes the SSE stream on anything that is not queued/running, so mapping these to a
  // verdict would drop the connection before the result root exists.
  assert.equal(toWireVerificationStatus("publishing"), "running");
  assert.equal(toWireVerificationStatus("publish_pending"), "running");
});

console.log("enums: all cases passed");
