#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="$repo_root/artifacts/e2e-fixtures"
deployments="$output_root/testnet-deployments.ndjson"
history="$output_root/testnet-ttl-history.ndjson"
account_alias="${SCVS_FIXTURE_TESTNET_ACCOUNT:-}"
ledgers="${SCVS_FIXTURE_TTL_LEDGERS:-500000}"

if [[ -z "$account_alias" ]]; then
  echo "SCVS_FIXTURE_TESTNET_ACCOUNT must name a local Stellar key alias" >&2
  exit 1
fi
if [[ ! "$ledgers" =~ ^[1-9][0-9]*$ ]]; then
  echo "SCVS_FIXTURE_TTL_LEDGERS must be a positive integer" >&2
  exit 1
fi
if [[ ! -s "$deployments" ]]; then
  echo "missing deployment records: $deployments" >&2
  exit 1
fi

while IFS= read -r deployment; do
  fixture_id="$(jq -r '.fixture_id' <<<"$deployment")"
  contract_id="$(jq -r '.contract_id' <<<"$deployment")"
  wasm_hash="$(jq -r '.wasm_hash' <<<"$deployment")"
  instance_ttl="$(
    stellar contract extend \
      --id "$contract_id" \
      --ledgers-to-extend "$ledgers" \
      --ttl-ledger-only \
      --source-account "$account_alias" \
      --network testnet
  )"
  code_ttls='[]'
  while IFS= read -r code_hash; do
    code_ttl="$(
      stellar contract extend \
        --wasm-hash "$code_hash" \
        --ledgers-to-extend "$ledgers" \
        --ttl-ledger-only \
        --source-account "$account_alias" \
        --network testnet
    )"
    code_ttls="$(
      jq -c \
        --arg wasm_hash "$code_hash" \
        --arg live_until "$code_ttl" \
        '. + [{wasm_hash:$wasm_hash,live_until:$live_until}]' \
        <<<"$code_ttls"
    )"
  done < <(jq -r '[.wasm_hash, .prepared_new_wasm_hash // empty] | unique[]' <<<"$deployment")
  jq -nc \
    --arg fixture_id "$fixture_id" \
    --arg contract_id "$contract_id" \
    --arg wasm_hash "$wasm_hash" \
    --argjson ledgers_to_extend "$ledgers" \
    --arg instance_live_until "$instance_ttl" \
    --argjson code_ttls "$code_ttls" \
    --arg extended_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{fixture_id:$fixture_id,contract_id:$contract_id,wasm_hash:$wasm_hash,ledgers_to_extend:$ledgers_to_extend,instance_live_until:$instance_live_until,code_ttls:$code_ttls,extended_at:$extended_at}' \
    >> "$history"
  echo "extended $fixture_id to instance=$instance_ttl code=$(jq -c . <<<"$code_ttls")"
done < <(jq -c . "$deployments")
