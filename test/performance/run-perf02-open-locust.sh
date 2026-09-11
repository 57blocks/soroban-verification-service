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
  [[ "$2" =~ ^[1-9][0-9]*$ ]] || { echo "$1 must be a positive integer" >&2; exit 1; }
}

positive_number() {
  [[ "$2" =~ ^[0-9]+([.][0-9]+)?$ ]] && [[ "$2" != "0" && "$2" != "0.0" ]] || {
    echo "$1 must be a positive number" >&2; exit 1;
  }
}

for command in docker git jq python3; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done

verify_url="$(configured_value SCVS_E2E_VERIFY_URL || true)"
fixtures="$(configured_value SCVS_E2E_FIXTURES || true)"
fixtures="${fixtures:-test/integration/fixtures/e2e-fixtures.dev.json}"
e2e_enabled="$(configured_value SCVS_E2E || true)"
perf_enabled="$(configured_value SCVS_E2E_ALLOW_PERF || true)"
duration_seconds="$(configured_value SCVS_E2E_PERF_OPEN_DURATION_SECONDS || true)"
burst_size="$(configured_value SCVS_E2E_PERF_OPEN_BURST_SIZE || true)"
interval_seconds="$(configured_value SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS || true)"
max_in_flight="$(configured_value SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT || true)"
max_rebuilds="$(configured_value SCVS_E2E_PERF_MAX_REBUILDS || true)"
drain_timeout_ms="$(configured_value SCVS_E2E_PERF_DRAIN_TIMEOUT_MS || true)"
poll_interval_ms="$(configured_value SCVS_E2E_POLL_INTERVAL_MS || true)"
request_timeout_ms="$(configured_value SCVS_E2E_REQUEST_TIMEOUT_MS || true)"

[[ -n "$verify_url" ]] || { echo "SCVS_E2E_VERIFY_URL is required" >&2; exit 1; }
case "$e2e_enabled" in 1|true|TRUE|True) ;; *) echo "SCVS_E2E=1 is required because PERF-02 submits real builds" >&2; exit 1;; esac
case "$perf_enabled" in 1|true|TRUE|True) ;; *) echo "SCVS_E2E_ALLOW_PERF=1 is required for PERF-02" >&2; exit 1;; esac
positive_integer SCVS_E2E_PERF_OPEN_DURATION_SECONDS "$duration_seconds"
positive_integer SCVS_E2E_PERF_OPEN_BURST_SIZE "$burst_size"
positive_number SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS "$interval_seconds"
positive_integer SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT "$max_in_flight"
positive_integer SCVS_E2E_PERF_MAX_REBUILDS "$max_rebuilds"
if (( burst_size > max_in_flight )); then
  echo "SCVS_E2E_PERF_OPEN_BURST_SIZE must not exceed SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT" >&2
  exit 1
fi
if (( burst_size > max_rebuilds )); then
  echo "SCVS_E2E_PERF_MAX_REBUILDS must be at least SCVS_E2E_PERF_OPEN_BURST_SIZE" >&2
  exit 1
fi
positive_integer SCVS_E2E_PERF_DRAIN_TIMEOUT_MS "$drain_timeout_ms"
poll_interval_ms="${poll_interval_ms:-3000}"
request_timeout_ms="${request_timeout_ms:-60000}"
positive_integer SCVS_E2E_POLL_INTERVAL_MS "$poll_interval_ms"
positive_integer SCVS_E2E_REQUEST_TIMEOUT_MS "$request_timeout_ms"

if [[ "$fixtures" = /* ]]; then
  case "$fixtures" in "$repo_root"/*) fixture_relative="${fixtures#"$repo_root/"}" ;; *) echo "SCVS_E2E_FIXTURES must be inside the repository for the Locust container" >&2; exit 1;; esac
else
  fixture_relative="$fixtures"
fi
fixture_path="$repo_root/$fixture_relative"
[[ -f "$fixture_path" ]] || { echo "fixture inventory does not exist: $fixture_path" >&2; exit 1; }
available_targets="$(jq -er '.performance_verified.targets | length' "$fixture_path")"
if (( max_in_flight > available_targets )); then
  echo "SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT=$max_in_flight exceeds the target pool of $available_targets" >&2
  exit 1
fi

output_root="${SCVS_E2E_PERF_OUTPUT_DIR:-$repo_root/artifacts/e2e-reports/perf-02}"
mkdir -p "$output_root"
drain_timeout_seconds=$(( (drain_timeout_ms + 999) / 1000 ))
run_id="${SCVS_E2E_RUN_ID:-locust-open-$(date +%Y%m%d%H%M%S)-$RANDOM-$RANDOM}"
host_uid="$(id -u)"
host_gid="$(id -g)"

exit_code=0
docker run --rm \
  --user "$host_uid:$host_gid" \
  --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
  --mount "type=bind,source=$output_root,target=/results" \
  -e SCVS_E2E_VERIFY_URL="$verify_url" \
  -e SCVS_E2E_FIXTURES="/workspace/$fixture_relative" \
  -e SCVS_E2E_PERF_RESULT_DIR=/results \
  -e SCVS_E2E_PERF_OPEN_DURATION_SECONDS="$duration_seconds" \
  -e SCVS_E2E_PERF_OPEN_BURST_SIZE="$burst_size" \
  -e SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS="$interval_seconds" \
  -e SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT="$max_in_flight" \
  -e SCVS_E2E_PERF_MAX_REBUILDS="$max_rebuilds" \
  -e SCVS_E2E_PERF_DRAIN_TIMEOUT_SECONDS="$drain_timeout_seconds" \
  -e SCVS_E2E_POLL_INTERVAL_SECONDS="$(awk "BEGIN { print $poll_interval_ms / 1000 }")" \
  -e SCVS_E2E_REQUEST_TIMEOUT_SECONDS="$(( (request_timeout_ms + 999) / 1000 ))" \
  -e SCVS_E2E_RUN_ID="$run_id" \
  locustio/locust:2.37.10 \
  -f /workspace/test/performance/locustfile_perf02.py \
  --headless --users 1 --spawn-rate 1 \
  --stop-timeout "$drain_timeout_seconds" \
  --exit-code-on-error 1 \
  --csv /results/perf-02 --html /results/perf-02.html || exit_code=$?

# Locust's HTML report is a fixed SPA template and cannot show the run's own parameters, so splice a parameter
# banner into the generated report.
[ -f "$output_root/perf-02.html" ] || exit "$exit_code"
python3 - "$output_root/perf-02.html" "$duration_seconds" "$burst_size" "$interval_seconds" "$max_in_flight" "$max_rebuilds" "$run_id" <<'PYEOF'
import sys

html_path, duration, burst, interval, max_in_flight, max_rebuilds, run_id = sys.argv[1:8]
banner = (
    '<div style="position:fixed;bottom:0;left:0;right:0;z-index:9999;'
    'background:#0b0e14;color:#d0d7e2;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;'
    'padding:8px 16px;border-top:1px solid #2a3140;white-space:nowrap;overflow-x:auto;">'
    '<strong style="color:#7ce38b;">PERF-02</strong> &nbsp;'
    f'SCVS_E2E_PERF_OPEN_BURST_SIZE={burst} &nbsp;|&nbsp; '
    f'SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS={interval} &nbsp;|&nbsp; '
    f'SCVS_E2E_PERF_OPEN_DURATION_SECONDS={duration} &nbsp;|&nbsp; '
    f'SCVS_E2E_PERF_OPEN_MAX_IN_FLIGHT={max_in_flight} &nbsp;|&nbsp; '
    f'SCVS_E2E_PERF_MAX_REBUILDS={max_rebuilds} &nbsp;|&nbsp; '
    f'run_id={run_id}'
    '</div>'
)
with open(html_path, encoding="utf-8") as handle:
    html = handle.read()
# Locust's bundle embeds an index.html template string that also contains a `</body>`, so anchor on the *last*
# one — the real document body close — rather than the first occurrence.
idx = html.rfind("</body>")
if idx == -1:
    raise SystemExit(f"</body> not found in {html_path}")
html = html[:idx] + banner + html[idx:]
with open(html_path, "w", encoding="utf-8") as handle:
    handle.write(html)
PYEOF

exit "$exit_code"
