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

for command in cargo docker git jq perl pnpm shasum; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done

account_locator="$(configured_value SCVS_FIXTURE_TESTNET_ACCOUNT || true)"
[[ -n "$account_locator" ]] || { echo "SCVS_FIXTURE_TESTNET_ACCOUNT is required" >&2; exit 1; }
for required in SCVS_E2E_VERIFY_URL SCVS_E2E_QUERY_URL SCVS_E2E_RESULT_ROOT; do
  [[ -n "$(configured_value "$required" || true)" ]] || {
    echo "$required is required in the environment, test/integration/.env, or .env" >&2; exit 1;
  }
done

scope="${SCVS_E2E_RUN_ID:-upgrade-$(date +%Y%m%d%H%M%S)-$RANDOM-$RANDOM}"
[[ "$scope" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "SCVS_E2E_RUN_ID must be a filesystem-safe scope identifier" >&2; exit 1;
}
output_root="$repo_root/artifacts/e2e-fixtures/upgrade/$scope"

source "$repo_root/test/fixtures/e2e/released-stellar-cli.sh"
cli_bin="$(scvs_released_stellar_cli)"
[[ -x "$cli_bin" ]] || { echo "Stellar CLI is not executable: $cli_bin" >&2; exit 1; }
"$cli_bin" contract info meta --help >/dev/null

export PATH="$(dirname "$cli_bin"):$PATH"
export SCVS_FIXTURE_STELLAR_BIN="$cli_bin"
export SCVS_FIXTURE_OUTPUT_ROOT="$output_root"
export SCVS_FIXTURE_DEPLOYMENT_SCOPE="$scope"
export SCVS_FIXTURE_DEPLOYMENTS="$output_root/testnet-deployments.ndjson"
export SCVS_FIXTURE_BUILD_SCOPE=upgrade
export SCVS_FIXTURE_TESTNET_ACCOUNT="$account_locator"
export SCVS_E2E_BASE_FIXTURES="test/integration/fixtures/e2e-fixtures.dev.json"
export SCVS_E2E_FIXTURES="$output_root/e2e-upgrade-fixtures.json"
export SCVS_E2E_BUILD_MANIFEST="$output_root/purpose-built-wasm.ndjson"
export SCVS_E2E_RUN_ID="$scope"
export SCVS_E2E=1
export SCVS_E2E_NETWORK=testnet

bash "$repo_root/test/fixtures/e2e/build-purpose-contracts.sh"
bash "$repo_root/test/fixtures/e2e/prepare-upgrade-testnet.sh"
pnpm run e2e:generate-upgrade-inventory
pnpm run e2e:check-upgrade-fixtures

echo "running E2E-UPG-01 with fixture scope $scope"
pnpm --filter @scvs/e2e-tests run test:jest "${jest_args[@]}"
