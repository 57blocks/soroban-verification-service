#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="${SCVS_FIXTURE_OUTPUT_ROOT:-$repo_root/artifacts/e2e-fixtures}"
wasm_root="$output_root/wasm/purpose-built"
deployments="${SCVS_FIXTURE_DEPLOYMENTS:-$output_root/testnet-deployments.ndjson}"
account_locator="${SCVS_FIXTURE_TESTNET_ACCOUNT:-}"
deployment_scope="${SCVS_FIXTURE_DEPLOYMENT_SCOPE:-stable}"
deploy_set="${SCVS_FIXTURE_DEPLOY_SET:-all}"
perf_target_count="${SCVS_FIXTURE_PERF_TARGET_COUNT:-}"
work_root="$(mktemp -d /tmp/scvs-e2e-deploy.XXXXXX)"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-deploy.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ -z "$account_locator" ]]; then
  echo "SCVS_FIXTURE_TESTNET_ACCOUNT must provide a Stellar key alias, secret key, or seed phrase" >&2
  exit 1
fi
if [[ -z "$deployment_scope" ]]; then
  echo "SCVS_FIXTURE_DEPLOYMENT_SCOPE must not be empty" >&2
  exit 1
fi
if [[ "$deploy_set" != "all" && "$deploy_set" != "core" && "$deploy_set" != "timeout" && "$deploy_set" != "perf" && "$deploy_set" != "image-policy" && "$deploy_set" != "multi-package" && "$deploy_set" != "compose-only" && "$deploy_set" != "zip" ]]; then
  echo "SCVS_FIXTURE_DEPLOY_SET must be all, core, timeout, perf, image-policy, multi-package, compose-only, or zip" >&2
  exit 1
fi
if [[ "$deploy_set" == "perf" ]] && ! [[ "$perf_target_count" =~ ^[1-9][0-9]*$ ]] || \
  [[ "$deploy_set" == "perf" && "$perf_target_count" -gt 200 ]]; then
  echo "SCVS_FIXTURE_PERF_TARGET_COUNT must be an integer from 1 through 200 for deploy set perf" >&2
  exit 1
fi

for command in stellar jq shasum; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

mkdir -p "$output_root" "$(dirname "$deployments")"
touch "$deployments"
public_account="$(stellar keys address "$account_locator")"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

deploy_one() {
  local fixture_id="$1"
  local wasm_file="$2"
  local expected_class="$3"
  local wasm_path="$wasm_root/$wasm_file"
  local expected_hash
  local salt
  local salt_input
  local contract_id
  local fetched_wasm
  local fetched_hash
  local metadata

  if [[ ! -f "$wasm_path" ]]; then
    echo "missing purpose-built Wasm: $wasm_path" >&2
    exit 1
  fi

  if jq -e --arg id "$fixture_id" --arg scope "$deployment_scope" \
    'select(.fixture_id == $id and (.deployment_scope // "stable") == $scope)' \
    "$deployments" >/dev/null; then
    echo "already recorded: $fixture_id ($deployment_scope)"
    return
  fi

  expected_hash="$(sha256_file "$wasm_path")"
  if [[ "$deployment_scope" == "stable" ]]; then
    salt_input="scvs-e2e:$fixture_id"
  else
    salt_input="scvs-e2e:$deployment_scope:$fixture_id"
  fi
  salt="$(printf '%s' "$salt_input" | shasum -a 256 | awk '{print $1}')"
  contract_id="$(
    stellar contract deploy \
      --wasm "$wasm_path" \
      --source-account "$account_locator" \
      --network testnet \
      --salt "$salt"
  )"
  if [[ ! "$contract_id" =~ ^C[A-Z2-7]{55}$ ]]; then
    echo "unexpected contract ID for $fixture_id: $contract_id" >&2
    exit 1
  fi

  fetched_wasm="$work_root/$fixture_id.wasm"
  stellar contract fetch \
    --id "$contract_id" \
    --network testnet \
    --out-file "$fetched_wasm"
  fetched_hash="$(sha256_file "$fetched_wasm")"
  if [[ "$fetched_hash" != "$expected_hash" ]]; then
    echo "$fixture_id fetched hash $fetched_hash, expected $expected_hash" >&2
    exit 1
  fi

  metadata="$(stellar contract info meta --wasm "$fetched_wasm" --output json)"
  jq -nc \
    --arg fixture_id "$fixture_id" \
    --arg network "testnet" \
    --arg contract_id "$contract_id" \
    --arg wasm_hash "$fetched_hash" \
    --arg expected_class "$expected_class" \
    --arg source_account "$public_account" \
    --arg deployment_scope "$deployment_scope" \
    --argjson metadata "$metadata" \
    '{fixture_id:$fixture_id,deployment_scope:$deployment_scope,network:$network,contract_id:$contract_id,wasm_hash:$wasm_hash,expected_class:$expected_class,source_account:$source_account,metadata:$metadata}' \
    >> "$deployments"
  echo "deployed $fixture_id: $contract_id ($fetched_hash)"
}

if [[ "$deploy_set" == "all" || "$deploy_set" == "core" ]]; then
  deploy_one "F-LEG-1-testnet" "f-leg-1-official.wasm" "cli-legacy"
  # Each timeout case leaves its retry live, so each needs its own target, apart from F-LEG-1.
  deploy_one "F-SUB09-TIMEOUT-testnet" "f-leg-1-official.wasm" "cli-legacy"
  deploy_one "F-SUB10-TIMEOUT-testnet" "f-leg-1-official.wasm" "cli-legacy"
  deploy_one "F-RULE-D-TIMEOUT-testnet" "f-leg-1-official.wasm" "cli-legacy"
  deploy_one "F-LEG-3-target" "f-leg-3-target.wasm" "cli-legacy"
  deploy_one "F-S55-E-testnet" "f-s55-e.wasm" "cli-legacy"
  deploy_one "F-S55-F-testnet" "f-s55-f.wasm" "cli-legacy"
  deploy_one "F-58-PRIV-testnet" "f-58-private.wasm" "cli-58"
  deploy_one "F-58-ZIP-testnet" "f-58-zip-source.wasm" "cli-58"
  deploy_one "F-58-ZIP-PUBLIC-testnet" "f-58-public-zip-source.wasm" "cli-58"
fi
if [[ "$deploy_set" == "timeout" ]]; then
  deploy_one "F-SUB09-TIMEOUT-testnet" "f-leg-1-official.wasm" "cli-legacy"
  deploy_one "F-SUB10-TIMEOUT-testnet" "f-leg-1-official.wasm" "cli-legacy"
  deploy_one "F-RULE-D-TIMEOUT-testnet" "f-leg-1-official.wasm" "cli-legacy"
fi
if [[ "$deploy_set" == "zip" ]]; then
  deploy_one "F-58-ZIP-testnet" "f-58-zip-source.wasm" "cli-58"
  deploy_one "F-58-ZIP-PUBLIC-testnet" "f-58-public-zip-source.wasm" "cli-58"
fi
if [[ "$deploy_set" == "perf" ]]; then
  for sequence in $(seq 1 "$perf_target_count"); do
    fixture_id="$(printf 'F-PERF-VERIFIED-%03d' "$sequence")"
    deploy_one "$fixture_id" "f-leg-1-official.wasm" "cli-legacy"
  done
fi
if [[ "$deploy_set" == "all" ]]; then
  deploy_one "F-58-testnet" "f-58-complete.wasm" "cli-58"
  deploy_one "F-NONE-testnet" "f-none.wasm" "cli-none"
  deploy_one "F-S55-A" "f-s55-a.wasm" "cli-legacy"
  deploy_one "F-S55-B" "f-s55-b.wasm" "cli-legacy"
  deploy_one "F-S55-C" "f-s55-c.wasm" "cli-legacy"
  deploy_one "F-S55-D" "f-s55-d.wasm" "cli-58"
fi
if [[ "$deploy_set" == "all" || "$deploy_set" == "image-policy" ]]; then
  deploy_one "F-BADIMG-TAG" "f-badimg-tag.wasm" "cli-58"
  deploy_one "F-BADIMG-UNTRUSTED" "f-badimg-untrusted.wasm" "cli-58"
fi
if [[ "$deploy_set" == "all" || "$deploy_set" == "multi-package" ]]; then
  deploy_one "F-MULTIPKG-testnet" "f-multipkg-contract-b.wasm" "cli-legacy"
fi
if [[ "$deploy_set" == "compose-only" ]]; then
  compose_pending=()
  for compose_row in \
    "F-COMPOSE-ONLY|f-compose-only.wasm" \
    "F-DEMAND-01|f-demand-01.wasm" \
    "F-OLD-END|f-old-end.wasm"; do
    IFS='|' read -r compose_id compose_wasm <<<"$compose_row"
    if [[ -f "$wasm_root/$compose_wasm" ]]; then
      deploy_one "$compose_id-testnet" "$compose_wasm" "cli-legacy"
    else
      compose_pending+=("$compose_id")
      echo "not built yet, skipping: $compose_id ($compose_wasm)"
    fi
  done
  if [[ ${#compose_pending[@]} -gt 0 ]]; then
    echo ""
    echo "still to build (${#compose_pending[@]}): ${compose_pending[*]}"
    echo "for each: compose its image, then"
    echo "  SCVS_FIXTURE_BUILD_SCOPE=compose-only SCVS_FIXTURE_COMPOSE_TARGET=<id> \\"
    echo "    SCVS_FIXTURE_BUILD_IMAGE=scvs-composed:template-gate-v3 \\"
    echo "    bash test/fixtures/e2e/build-purpose-contracts.sh"
    echo "then re-run this script; already-recorded deployments are skipped."
  fi
fi
