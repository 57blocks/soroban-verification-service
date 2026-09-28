#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
inventory="${SCVS_E2E_FIXTURES:-${repo_root}/test/integration/fixtures/e2e-fixtures.dev.json}"
archive="${repo_root}/artifacts/e2e-fixtures/archives/mismatch.tar.gz"

command -v jq >/dev/null || { echo "prepare-query-verifier-fixtures: jq is required" >&2; exit 1; }
[[ -f "$inventory" ]] || { echo "fixture inventory not found: $inventory" >&2; exit 1; }
[[ -f "$archive" ]] || {
  echo "missing $archive; run test/fixtures/e2e/generate-fixtures.sh first" >&2
  exit 1
}

target_network="$(jq -er '.contracts["F-LEG-1"].network' "$inventory")"
target_contract="$(jq -er '.contracts["F-LEG-1"].contract_id' "$inventory")"
target_hash="$(jq -er '.contracts["F-LEG-1"].wasm_hash' "$inventory")"
canonical_uri="$(jq -er '.contracts["F-LEG-1"].source_uri' "$inventory")"
canonical_sha="$(jq -er '.contracts["F-LEG-1"].source_sha256' "$inventory")"
mismatch_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"

cat <<EOF
QRY fixture preparation (no chain deployment required)

Shared target:
  fixture:       F-LEG-1
  network:       ${target_network}
  contract_id:   ${target_contract}
  wasm_hash:     ${target_hash}
  matching URI:  ${canonical_uri}
  matching SHA:  ${canonical_sha}

Staging disagreement source:
  archive:       ${archive}
  source_sha256: ${mismatch_sha}
  expected peer result: mismatched for the same ${target_hash}

After dev/staging are reachable:
  1. Submit F-LEG-1 with its canonical source to dev and wait for verified publication.
  2. Upload the archive above to staging, submit it against network=${target_network},
     contract_id=${target_contract}, and wait for mismatched publication.
  3. Set SCVS_E2E_DISPUTED_HASH=${target_hash} and SCVS_E2E_PEER_RESULT_ROOT to staging's
     public result root; run E2E-QRY-02.
  4. Add a permanently unreachable TVL row (the QRY dead verifier), or stop staging for the
     outage window; set SCVS_E2E_QRY_UNAVAILABLE_VERIFIER_ID and run QRY-03/QRY-04.
  5. For QRY-05, first let staging sync the published result, then make it unreachable and wait
     at least SCVS_E2E_QRY_MIN_STALE_AGE_MS before running the case.

The testnet contract is F-LEG-1 from registry.yaml; this script does not create a second contract.
EOF
