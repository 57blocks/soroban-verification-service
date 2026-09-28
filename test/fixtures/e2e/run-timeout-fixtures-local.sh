#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
jest_args=("$@")
if [[ "${jest_args[0]:-}" == "--" ]]; then
  jest_args=("${jest_args[@]:1}")
fi

dotenv_value() {
  local key="$1" dotenv_path line value
  for dotenv_path in "$repo_root/test/integration/.env" "$repo_root/.env"; do
    [[ -f "$dotenv_path" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        "$key"=*)
          value="${line#*=}"
          value="${value%$'\r'}"
          if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
          printf '%s\n' "$value"
          return 0
          ;;
      esac
    done < "$dotenv_path"
  done
  return 1
}

configured_value() {
  local key="$1"
  [[ -n "${!key:-}" ]] && { printf '%s\n' "${!key}"; return; }
  dotenv_value "$key"
}

for command in git jq pnpm shasum stellar; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done

account_locator="$(configured_value SCVS_FIXTURE_TESTNET_ACCOUNT || true)"
[[ -n "$account_locator" ]] || { echo "SCVS_FIXTURE_TESTNET_ACCOUNT is required (use a funded local Stellar key alias)" >&2; exit 1; }
[[ "$account_locator" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "SCVS_FIXTURE_TESTNET_ACCOUNT must be a local Stellar key alias" >&2; exit 1; }
[[ -n "$(configured_value SCVS_E2E_VERIFY_URL || true)" ]] || { echo "SCVS_E2E_VERIFY_URL is required" >&2; exit 1; }

timeout_wasm="$repo_root/artifacts/e2e-fixtures/wasm/purpose-built/f-leg-1-official.wasm"
[[ -f "$timeout_wasm" ]] || {
  echo "missing $timeout_wasm; build the purpose fixtures before selecting a timeout E2E case" >&2
  exit 1
}
timeout_archive="$repo_root/artifacts/e2e-fixtures/archives/build-timeout.tar.gz"
[[ -f "$timeout_archive" ]] || {
  echo "missing $timeout_archive; run test/fixtures/e2e/generate-fixtures.sh before selecting a timeout E2E case" >&2
  exit 1
}

scope="${SCVS_E2E_RUN_ID:-timeout-$(date +%Y%m%d%H%M%S)-$RANDOM-$RANDOM}"
[[ "$scope" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "SCVS_E2E_RUN_ID must be filesystem-safe" >&2; exit 1; }
output_root="$repo_root/artifacts/e2e-fixtures/timeout/$scope"

export SCVS_FIXTURE_OUTPUT_ROOT="$repo_root/artifacts/e2e-fixtures"
export SCVS_FIXTURE_DEPLOYMENT_SCOPE="$scope"
export SCVS_FIXTURE_DEPLOYMENTS="$output_root/testnet-deployments.ndjson"
export SCVS_FIXTURE_TESTNET_ACCOUNT="$account_locator"
export SCVS_E2E_BASE_FIXTURES="test/integration/fixtures/e2e-fixtures.dev.json"
export SCVS_E2E_FIXTURES="$output_root/e2e-timeout-fixtures.json"
export SCVS_E2E_FIXTURE_OVERLAY=timeout
export SCVS_E2E_RUN_ID="$scope"
export SCVS_E2E=1
export SCVS_E2E_NETWORK=testnet

SCVS_FIXTURE_DEPLOY_SET=timeout bash "$repo_root/test/fixtures/e2e/deploy-testnet.sh"
pnpm run e2e:generate-inventory
pnpm run e2e:check-fixtures

echo "running timeout E2E with fixture scope $scope"
# `pnpm run` already forwards trailing arguments; a second `--` would reach Jest literally.
pnpm --filter @scvs/e2e-tests run test:jest "${jest_args[@]}"
