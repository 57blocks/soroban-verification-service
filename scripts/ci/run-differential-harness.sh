#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# `grep`, not `rg`: ripgrep is installed nowhere in this repository's CI, and `if rg …; then` reads exit 127
# (no such command) exactly as it reads exit 1 (no match) — so this guard passed by never running. Both
# halves now fail closed: an empty search set is an error, not a pass.
targets=(services/*/src)
if [ ! -d "${targets[0]}" ]; then
  echo "::error::no services/*/src to scan, so this guard would pass by finding nothing" >&2
  exit 1
fi
set +e
leaks="$(grep -rnF "docker/prebuilt/bin/stellar" "${targets[@]}")"
grep_status=$?
set -e
case "$grep_status" in
  0)
    printf '%s\n' "$leaks"
    echo "::error::The pinned reference binary must stay out of service runtime code."
    exit 1
    ;;
  1) ;; # a real search that found nothing
  *)
    echo "::error::the leak scan itself failed (grep exit ${grep_status}); refusing to read that as clean" >&2
    exit 1
    ;;
esac

bash scripts/ci/fetch-or-build-stellar-cli.sh

SCVS_DIFFERENTIAL=1 \
SCVS_DIFFERENTIAL_HOST_LABEL="${SCVS_DIFFERENTIAL_HOST_LABEL:-$(uname -m)-$(uname -s)}" \
pnpm --filter @scvs/builder run test -- differential

# T2 is "the same harness run twice with different --host-label, then reproducibility.spec.ts compares the two
# committed manifests" (docs/features/differential-harness/plan.md §3). It must be a *second* jest invocation:
# jest runs the two spec files in parallel workers, so a comparison sharing the invocation above could read
# results/ before this host's own manifest had been written. Off by default — with one manifest it can only
# fail on its own precondition, which is not evidence of anything.
if [ "${SCVS_COMPARE_HOST_MANIFESTS:-0}" = "1" ]; then
  SCVS_DIFFERENTIAL=1 \
  SCVS_COMPARE_HOST_MANIFESTS=1 \
  pnpm --filter @scvs/builder run test -- reproducibility
fi
