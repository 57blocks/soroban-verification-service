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
  if [[ -n "${!key:-}" ]]; then printf '%s\n' "${!key}"; return 0; fi
  dotenv_value "$key"
}

for command in cargo docker git jq perl pnpm shasum bsdtar; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done

account_locator="$(configured_value SCVS_FIXTURE_TESTNET_ACCOUNT || true)"
if [[ -z "$account_locator" ]]; then
  echo "SCVS_FIXTURE_TESTNET_ACCOUNT is required (use a funded local Stellar key alias)" >&2
  exit 1
fi
if [[ ! "$account_locator" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "SCVS_FIXTURE_TESTNET_ACCOUNT must be a local Stellar key alias, not a raw secret" >&2
  exit 1
fi
for required in SCVS_E2E_VERIFY_URL SCVS_E2E_RESULT_ROOT; do
  [[ -n "$(configured_value "$required" || true)" ]] || { echo "$required is required in the environment, test/integration/.env, or .env" >&2; exit 1; }
done

scope="${SCVS_E2E_RUN_ID:-local-zip-$(date +%Y%m%d%H%M%S)-$RANDOM-$RANDOM}"
[[ "$scope" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "SCVS_E2E_RUN_ID must be filesystem-safe" >&2; exit 1; }
output_root="$repo_root/artifacts/e2e-fixtures/local/$scope"
source "$repo_root/test/fixtures/e2e/released-stellar-cli.sh"
cli_bin="$(scvs_released_stellar_cli)"
[[ -x "$cli_bin" ]] || { echo "SCVS_FIXTURE_STELLAR_BIN is not executable: $cli_bin" >&2; exit 1; }
"$cli_bin" contract info meta --help >/dev/null

export PATH="$(dirname "$cli_bin"):$PATH"
export SCVS_FIXTURE_STELLAR_BIN="$cli_bin"

export SCVS_FIXTURE_OUTPUT_ROOT="$output_root"
export SCVS_FIXTURE_DEPLOYMENT_SCOPE="$scope"
export SCVS_FIXTURE_DEPLOYMENTS="$output_root/testnet-deployments.ndjson"
export SCVS_E2E_BASE_FIXTURES="test/integration/fixtures/e2e-fixtures.dev.json"
export SCVS_E2E_FIXTURES="$output_root/e2e-fixtures.json"
export SCVS_E2E_RUN_ID="$scope"
export SCVS_E2E=1
export SCVS_E2E_NETWORK=testnet
export SCVS_FIXTURE_ALLOW_PLATFORM_HASH=1

SCVS_E2E_FIXTURES="test/integration/fixtures/e2e-fixtures.dev.json" \
  SCVS_E2E_CANONICAL_SOURCE_ARCHIVE=artifacts/e2e-fixtures/archives/canonical-source.tar.gz \
  SCVS_FIXTURE_TAR_BIN=bsdtar SCVS_FIXTURE_ZIP_BIN=bsdtar SCVS_FIXTURE_ALLOW_PLATFORM_HASH=1 \
  bash "$repo_root/test/fixtures/e2e/prepare-ci-sources.sh"
SCVS_FIXTURE_BUILD_SCOPE=zip bash "$repo_root/test/fixtures/e2e/build-purpose-contracts.sh"
SCVS_FIXTURE_TESTNET_ACCOUNT="$account_locator" SCVS_FIXTURE_DEPLOY_SET=zip \
  bash "$repo_root/test/fixtures/e2e/deploy-testnet.sh"
SCVS_E2E_FIXTURE_OVERLAY=zip node "$repo_root/eng-tools/generate-e2e-ci-inventory.mjs"
SCVS_E2E_FIXTURE_OVERLAY=zip pnpm run e2e:check-fixtures

echo "running ZIP source-tree E2E fixtures with scope $scope"
pnpm --filter @scvs/e2e-tests run test:jest "${jest_args[@]}"
