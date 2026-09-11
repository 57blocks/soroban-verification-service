#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="${SCVS_FIXTURE_OUTPUT_ROOT:-$repo_root/artifacts/e2e-fixtures}"
wasm_root="$output_root/wasm/purpose-built"
deployments="${SCVS_FIXTURE_DEPLOYMENTS:-$output_root/testnet-deployments.ndjson}"
account_alias="${SCVS_FIXTURE_TESTNET_ACCOUNT:-}"
deployment_scope="${SCVS_FIXTURE_DEPLOYMENT_SCOPE:-stable}"
old_wasm="$wasm_root/f-upg-v1.wasm"
new_wasm="$wasm_root/f-upg-v2.wasm"
work_root="$(mktemp -d /tmp/scvs-e2e-upgrade.XXXXXX)"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-upgrade.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ -z "$account_alias" ]]; then
  echo "SCVS_FIXTURE_TESTNET_ACCOUNT must name a local Stellar key alias" >&2
  exit 1
fi

for command in jq shasum stellar; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

for wasm in "$old_wasm" "$new_wasm"; do
  if [[ ! -f "$wasm" ]]; then
    echo "missing purpose-built Wasm: $wasm" >&2
    exit 1
  fi
done

mkdir -p "$output_root"
touch "$deployments"
if jq -e --arg scope "$deployment_scope" \
  'select(.fixture_id == "F-UPG-testnet" and (.deployment_scope // "stable") == $scope)' \
  "$deployments" >/dev/null; then
  echo "F-UPG-testnet is already recorded for $deployment_scope"
  exit 0
fi

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

public_account="$(stellar keys address "$account_alias")"
old_hash="$(sha256_file "$old_wasm")"
new_hash="$(sha256_file "$new_wasm")"
salt="$(printf '%s' "scvs-e2e:$deployment_scope:F-UPG-testnet" | shasum -a 256 | awk '{print $1}')"

stellar contract upload \
  --wasm "$new_wasm" \
  --source-account "$account_alias" \
  --network testnet >/dev/null

contract_id="$(
  stellar contract deploy \
    --wasm "$old_wasm" \
    --source-account "$account_alias" \
    --network testnet \
    --salt "$salt"
)"

stellar contract invoke \
  --id "$contract_id" \
  --source-account "$account_alias" \
  --network testnet \
  -- init --admin "$public_account" >/dev/null

fetched_wasm="$work_root/current.wasm"
stellar contract fetch \
  --id "$contract_id" \
  --network testnet \
  --out-file "$fetched_wasm"
fetched_hash="$(sha256_file "$fetched_wasm")"
if [[ "$fetched_hash" != "$old_hash" ]]; then
  echo "F-UPG fetched hash $fetched_hash, expected $old_hash" >&2
  exit 1
fi

jq -nc \
  --arg fixture_id "F-UPG-testnet" \
  --arg network "testnet" \
  --arg contract_id "$contract_id" \
  --arg wasm_hash "$old_hash" \
  --arg prepared_new_wasm_hash "$new_hash" \
  --arg source_account "$public_account" \
  --arg deployment_scope "$deployment_scope" \
  '{fixture_id:$fixture_id,deployment_scope:$deployment_scope,network:$network,contract_id:$contract_id,wasm_hash:$wasm_hash,prepared_new_wasm_hash:$prepared_new_wasm_hash,source_account:$source_account,state:"old",upgrade_authority:"source_account"}' \
  >> "$deployments"

echo "prepared F-UPG-testnet: $contract_id ($old_hash -> $new_hash)"
