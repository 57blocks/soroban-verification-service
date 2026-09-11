#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

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

positive_integer() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "$name must be a positive integer" >&2; exit 1; }
}

non_negative_number() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "$name must be a non-negative number" >&2; exit 1; }
}

for command in docker git jq; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done

verify_url="$(configured_value SCVS_E2E_VERIFY_URL || true)"
fixtures="$(configured_value SCVS_E2E_FIXTURES || true)"
fixtures="${fixtures:-test/integration/fixtures/e2e-fixtures.dev.json}"
e2e_enabled="$(configured_value SCVS_E2E || true)"
perf_enabled="$(configured_value SCVS_E2E_ALLOW_PERF || true)"
users="$(configured_value SCVS_E2E_PERF_USERS || true)"
duration_seconds="$(configured_value SCVS_E2E_PERF_DURATION_SECONDS || true)"
think_time_seconds="$(configured_value SCVS_E2E_PERF_THINK_TIME_SECONDS || true)"
max_rebuilds="$(configured_value SCVS_E2E_PERF_MAX_REBUILDS || true)"
drain_timeout_ms="$(configured_value SCVS_E2E_PERF_DRAIN_TIMEOUT_MS || true)"
poll_interval_ms="$(configured_value SCVS_E2E_POLL_INTERVAL_MS || true)"
request_timeout_ms="$(configured_value SCVS_E2E_REQUEST_TIMEOUT_MS || true)"

[[ -n "$verify_url" ]] || { echo "SCVS_E2E_VERIFY_URL is required" >&2; exit 1; }
case "$e2e_enabled" in
  1|true|TRUE|True) ;;
  *) echo "SCVS_E2E=1 is required because PERF-01 submits real builds" >&2; exit 1 ;;
esac
case "$perf_enabled" in
  1|true|TRUE|True) ;;
  *) echo "SCVS_E2E_ALLOW_PERF=1 is required for PERF-01" >&2; exit 1 ;;
esac
positive_integer SCVS_E2E_PERF_USERS "$users"
positive_integer SCVS_E2E_PERF_DURATION_SECONDS "$duration_seconds"
non_negative_number SCVS_E2E_PERF_THINK_TIME_SECONDS "$think_time_seconds"
positive_integer SCVS_E2E_PERF_MAX_REBUILDS "$max_rebuilds"
if (( max_rebuilds < users )); then
  echo "SCVS_E2E_PERF_MAX_REBUILDS must be at least SCVS_E2E_PERF_USERS" >&2
  exit 1
fi
positive_integer SCVS_E2E_PERF_DRAIN_TIMEOUT_MS "$drain_timeout_ms"
poll_interval_ms="${poll_interval_ms:-3000}"
request_timeout_ms="${request_timeout_ms:-60000}"
positive_integer SCVS_E2E_POLL_INTERVAL_MS "$poll_interval_ms"
positive_integer SCVS_E2E_REQUEST_TIMEOUT_MS "$request_timeout_ms"

if [[ "$fixtures" = /* ]]; then
  case "$fixtures" in
    "$repo_root"/*) fixture_relative="${fixtures#"$repo_root/"}" ;;
    *) echo "SCVS_E2E_FIXTURES must be inside the repository for the Locust container" >&2; exit 1 ;;
  esac
else
  fixture_relative="$fixtures"
fi
fixture_path="$repo_root/$fixture_relative"
[[ -f "$fixture_path" ]] || { echo "fixture inventory does not exist: $fixture_path" >&2; exit 1; }
available_targets="$(jq -er '.performance_verified.targets | length' "$fixture_path")"
if (( users > available_targets )); then
  echo "SCVS_E2E_PERF_USERS=$users exceeds the target pool of $available_targets" >&2
  exit 1
fi

output_root="${SCVS_E2E_PERF_OUTPUT_DIR:-$repo_root/artifacts/e2e-reports/perf-01}"
mkdir -p "$output_root"
drain_timeout_seconds=$(( (drain_timeout_ms + 999) / 1000 ))
run_id="${SCVS_E2E_RUN_ID:-locust-$(date +%Y%m%d%H%M%S)-$RANDOM-$RANDOM}"
host_uid="$(id -u)"
host_gid="$(id -g)"

exec docker run --rm \
  --user "$host_uid:$host_gid" \
  --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
  --mount "type=bind,source=$output_root,target=/results" \
  -e SCVS_E2E_VERIFY_URL="$verify_url" \
  -e SCVS_E2E_FIXTURES="/workspace/$fixture_relative" \
  -e SCVS_E2E_PERF_RESULT_DIR=/results \
  -e SCVS_E2E_PERF_USERS="$users" \
  -e SCVS_E2E_PERF_DURATION_SECONDS="$duration_seconds" \
  -e SCVS_E2E_PERF_THINK_TIME_SECONDS="$think_time_seconds" \
  -e SCVS_E2E_PERF_MAX_REBUILDS="$max_rebuilds" \
  -e SCVS_E2E_PERF_DRAIN_TIMEOUT_SECONDS="$drain_timeout_seconds" \
  -e SCVS_E2E_POLL_INTERVAL_SECONDS="$(awk "BEGIN { print $poll_interval_ms / 1000 }")" \
  -e SCVS_E2E_REQUEST_TIMEOUT_SECONDS="$(( (request_timeout_ms + 999) / 1000 ))" \
  -e SCVS_E2E_RUN_ID="$run_id" \
  locustio/locust:2.37.10 \
  -f /workspace/test/performance/locustfile.py \
  --headless --users "$users" --spawn-rate "$users" \
  --run-time "${duration_seconds}s" --stop-timeout "$drain_timeout_seconds" \
  --exit-code-on-error 1 \
  --csv /results/perf-01 --html /results/perf-01.html
