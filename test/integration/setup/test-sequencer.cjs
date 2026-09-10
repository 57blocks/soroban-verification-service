/**
 * Runs the load-shaped specs last, so a probe that overwhelms the deployment cannot be mistaken for a defect in
 * whatever happened to be scheduled after it.
 */

/** Spec paths, repo-relative to this package, that must run after every other spec. */
const RUN_LAST = ["cases/sec/sec-surface-and-quota.spec.ts"];

const rank = (test) => {
  const path = String(test.path).split("\\").join("/");
  const index = RUN_LAST.findIndex((suffix) => path.endsWith(suffix));
  return index === -1 ? -1 : index;
};

class E2ETestSequencer {
  /** Preserves the incoming order, then moves RUN_LAST entries to the end in their listed order. */
  sort(tests) {
    return [...tests].sort((a, b) => rank(a) - rank(b));
  }

  /** Jest calls these on the sequencer it constructs. */
  allFailedTests(tests) {
    return this.sort(tests);
  }

  cacheResults() {}

  /** Never used — the suite is serial by construction — but shard() is part of the interface. */
  shard(tests, { shardIndex, shardCount }) {
    const ordered = this.sort(tests);
    const size = Math.ceil(ordered.length / shardCount);
    return ordered.slice((shardIndex - 1) * size, shardIndex * size);
  }
}

module.exports = E2ETestSequencer;
