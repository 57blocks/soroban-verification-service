#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="$repo_root/artifacts/e2e-fixtures"
candidate_root="$output_root/public-candidates"
manifest="$output_root/public-candidates.ndjson"
work_root="$(mktemp -d /tmp/scvs-e2e-public.XXXXXX)"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-public.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

for command in curl jq shasum stellar; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

mkdir -p "$candidate_root"
: > "$manifest"

contract_id="CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN"
wasm_hash="8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c"
source_revision="42f3116b0c5ea335181508c926e5ec48d67af419"
source_tag="v6.0.1_reflector-pulse-contract_cli27.0.0"
wasm="$candidate_root/reflector-pulse-v6.0.1.wasm"
source_archive="$candidate_root/reflector-pulse-v6.0.1.tar.gz"
contract_record="$work_root/contract.json"
tags="$work_root/tags.json"

curl -L --fail --silent --show-error --retry 3 \
  -o "$contract_record" \
  "https://api.stellar.expert/explorer/public/contract/$contract_id"
jq -e \
  --arg contract_id "$contract_id" \
  --arg wasm_hash "$wasm_hash" \
  --arg source_revision "$source_revision" \
  '.contract == $contract_id
    and .wasm == $wasm_hash
    and .validation.status == "verified"
    and .validation.commit == $source_revision' \
  "$contract_record" >/dev/null

curl -L --fail --silent --show-error --retry 3 \
  -o "$wasm" \
  "https://api.stellar.expert/explorer/public/wasm/$wasm_hash"
actual_wasm_hash="$(shasum -a 256 "$wasm" | awk '{print $1}')"
if [[ "$actual_wasm_hash" != "$wasm_hash" ]]; then
  echo "Reflector Wasm hash $actual_wasm_hash, expected $wasm_hash" >&2
  exit 1
fi
metadata="$(stellar contract info meta --wasm "$wasm" --output json)"

curl -L --fail --silent --show-error --retry 3 \
  -o "$tags" \
  "https://api.github.com/repos/reflector-network/reflector-contract/tags?per_page=100"
jq -e \
  --arg source_tag "$source_tag" \
  --arg source_revision "$source_revision" \
  'any(.[]; .name == $source_tag and .commit.sha == $source_revision)' \
  "$tags" >/dev/null

curl -L --fail --silent --show-error --retry 3 \
  -o "$source_archive" \
  "https://api.github.com/repos/reflector-network/reflector-contract/tarball/$source_revision"
source_sha256="$(shasum -a 256 "$source_archive" | awk '{print $1}')"

jq -nc \
  --arg fixture_id "F-LEG-2-mainnet-reflector" \
  --arg contract_id "$contract_id" \
  --arg wasm_hash "$wasm_hash" \
  --arg source_revision "$source_revision" \
  --arg source_tag "$source_tag" \
  --arg source_archive "${source_archive#"$repo_root/"}" \
  --arg source_sha256 "$source_sha256" \
  --argjson metadata "$metadata" \
  '{fixture_id:$fixture_id,network:"mainnet",contract_id:$contract_id,wasm_hash:$wasm_hash,source_revision:$source_revision,source_tag:$source_tag,source_archive:$source_archive,source_sha256:$source_sha256,metadata:$metadata,validated_by:"StellarExpert exact build record plus local hash and metadata checks"}' \
  >> "$manifest"

echo "validated F-LEG-2 mainnet candidate ($wasm_hash, source $source_sha256)"
