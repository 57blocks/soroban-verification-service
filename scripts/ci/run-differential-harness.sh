#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# `grep`, not `rg`: rg is absent in CI and its exit 127 would read as no match.
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
  1) ;;
  *)
    echo "::error::the leak scan itself failed (grep exit ${grep_status}); refusing to read that as clean" >&2
    exit 1
    ;;
esac

bash scripts/ci/fetch-or-build-stellar-cli.sh

SCVS_DIFFERENTIAL=1 \
SCVS_DIFFERENTIAL_HOST_LABEL="${SCVS_DIFFERENTIAL_HOST_LABEL:-$(uname -m)-$(uname -s)}" \
pnpm --filter @scvs/builder run test -- differential

# A second jest invocation: in the same one, parallel workers could compare before this host's manifest is written.
if [ "${SCVS_COMPARE_HOST_MANIFESTS:-0}" = "1" ]; then
  SCVS_DIFFERENTIAL=1 \
  SCVS_COMPARE_HOST_MANIFESTS=1 \
  pnpm --filter @scvs/builder run test -- reproducibility
fi
