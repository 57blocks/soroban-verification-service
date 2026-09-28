const RUN_LAST = ["cases/qry/qry-13-read-quota.spec.ts", "cases/sec/sec-surface-and-quota.spec.ts"];

const rank = (test) => {
  const path = String(test.path).split("\\").join("/");
  const index = RUN_LAST.findIndex((suffix) => path.endsWith(suffix));
  return index === -1 ? -1 : index;
};

class E2ETestSequencer {
  sort(tests) {
    return [...tests].sort((a, b) => rank(a) - rank(b));
  }

  allFailedTests(tests) {
    return this.sort(tests);
  }

  cacheResults() {}

  shard(tests, { shardIndex, shardCount }) {
    const ordered = this.sort(tests);
    const size = Math.ceil(ordered.length / shardCount);
    return ordered.slice((shardIndex - 1) * size, shardIndex * size);
  }
}

module.exports = E2ETestSequencer;
