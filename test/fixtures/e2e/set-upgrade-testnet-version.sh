#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="${SCVS_FIXTURE_OUTPUT_ROOT:-$repo_root/artifacts/e2e-fixtures}"
deployments="${SCVS_FIXTURE_DEPLOYMENTS:-$output_root/testnet-deployments.ndjson}"
history="$output_root/testnet-upgrade-history.ndjson"
account_alias="${SCVS_FIXTURE_TESTNET_ACCOUNT:-}"
deployment_scope="${SCVS_FIXTURE_DEPLOYMENT_SCOPE:-stable}"
version="${1:-}"
work_root="$(mktemp -d /tmp/scvs-e2e-set-upgrade.XXXXXX)"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-set-upgrade.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ -z "$account_alias" ]]; then
  echo "SCVS_FIXTURE_TESTNET_ACCOUNT must name a local Stellar key alias" >&2
  exit 1
fi
if [[ "$version" != "old" && "$version" != "new" ]]; then
  echo "usage: $0 old|new" >&2
  exit 1
fi

deployment="$(jq -c --arg scope "$deployment_scope" \
  'select(.fixture_id == "F-UPG-testnet" and (.deployment_scope // "stable") == $scope)' \
  "$deployments" | tail -1)"
if [[ -z "$deployment" ]]; then
  echo "F-UPG-testnet is not prepared" >&2
  exit 1
fi

contract_id="$(jq -r '.contract_id' <<<"$deployment")"
if [[ "$version" == "old" ]]; then
  target_hash="$(jq -r '.wasm_hash' <<<"$deployment")"
else
  target_hash="$(jq -r '.prepared_new_wasm_hash' <<<"$deployment")"
fi

stellar contract invoke \
  --id "$contract_id" \
  --source-account "$account_alias" \
  --network testnet \
  -- upgrade --new_wasm_hash "$target_hash" >/dev/null

stellar contract fetch \
  --id "$contract_id" \
  --network testnet \
  --out-file "$work_root/current.wasm"
actual_hash="$(shasum -a 256 "$work_root/current.wasm" | awk '{print $1}')"
if [[ "$actual_hash" != "$target_hash" ]]; then
  echo "F-UPG resolved to $actual_hash, expected $target_hash" >&2
  exit 1
fi

jq -nc \
  --arg fixture_id "F-UPG-testnet" \
  --arg deployment_scope "$deployment_scope" \
  --arg contract_id "$contract_id" \
  --arg state "$version" \
  --arg wasm_hash "$actual_hash" \
  --arg changed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{fixture_id:$fixture_id,deployment_scope:$deployment_scope,contract_id:$contract_id,state:$state,wasm_hash:$wasm_hash,changed_at:$changed_at}' \
  >> "$history"

echo "F-UPG-testnet now runs $version ($actual_hash)"
