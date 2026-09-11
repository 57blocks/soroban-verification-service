#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="$repo_root/artifacts/e2e-fixtures"
candidate_root="$output_root/public-testnet-candidates"
manifest="$output_root/public-testnet-candidates.ndjson"
stellar_expert="https://api.stellar.expert/explorer/testnet"

for command in curl jq shasum stellar; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

mkdir -p "$candidate_root"
: > "$manifest"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

metadata_has() {
  local metadata_file="$1"
  local key="$2"
  local expected="$3"
  jq -e --arg key "$key" --arg expected "$expected" '
    any(.[]; (.sc_meta_v0? // {}) | .key == $key and .val == $expected)
  ' "$metadata_file" >/dev/null
}

validate_candidate() {
  local fixture_id="$1"
  local contract_id="$2"
  local wasm_hash="$3"
  local expected_class="$4"
  local source_archive_url="$5"
  local source_sha256="$6"
  shift 6
  local -a metadata_expectations=("$@")

  local contract_json="$candidate_root/$fixture_id.contract.json"
  local wasm_file="$candidate_root/$fixture_id.wasm"
  local metadata_file="$candidate_root/$fixture_id.metadata.json"
  local source_archive="$candidate_root/$fixture_id.source.tar.gz"

  curl -L --fail --silent --show-error \
    "$stellar_expert/contract/$contract_id" -o "$contract_json"

  local observed_wasm_hash
  observed_wasm_hash="$(jq -r '.wasm // empty' "$contract_json")"
  if [[ "$observed_wasm_hash" != "$wasm_hash" ]]; then
    echo "$fixture_id wasm mismatch: expected $wasm_hash, got $observed_wasm_hash" >&2
    exit 1
  fi

  curl -L --fail --silent --show-error \
    "$stellar_expert/wasm/$wasm_hash" -o "$wasm_file"
  local downloaded_wasm_hash
  downloaded_wasm_hash="$(sha256_file "$wasm_file")"
  if [[ "$downloaded_wasm_hash" != "$wasm_hash" ]]; then
    echo "$fixture_id downloaded Wasm hash mismatch: expected $wasm_hash, got $downloaded_wasm_hash" >&2
    exit 1
  fi

  stellar contract info meta --wasm "$wasm_file" --output json > "$metadata_file"
  local observed_class
  observed_class="$(
    jq -r '
      if any(.[]; (.sc_meta_v0? // {}) | .key == "bldimg")
         and any(.[]; (.sc_meta_v0? // {}) | .key == "source_sha256")
      then "cli-58"
      elif any(.[]; (.sc_meta_v0? // {}) | .key == "cliver")
      then "cli-legacy"
      else "cli-none"
      end
    ' "$metadata_file"
  )"
  if [[ "$observed_class" != "$expected_class" ]]; then
    echo "$fixture_id class mismatch: expected $expected_class, got $observed_class" >&2
    exit 1
  fi

  local expectation
  for expectation in "${metadata_expectations[@]}"; do
    metadata_has "$metadata_file" "${expectation%%=*}" "${expectation#*=}" || {
      echo "$fixture_id missing metadata expectation: $expectation" >&2
      exit 1
    }
  done

  curl -L --fail --silent --show-error \
    "$source_archive_url" -o "$source_archive"
  local downloaded_source_sha256
  downloaded_source_sha256="$(sha256_file "$source_archive")"
  if [[ "$downloaded_source_sha256" != "$source_sha256" ]]; then
    echo "$fixture_id source archive hash mismatch: expected $source_sha256, got $downloaded_source_sha256" >&2
    exit 1
  fi

  local metadata_json
  metadata_json="$(jq -c '.' "$metadata_file")"
  jq -nc \
    --arg fixture_id "$fixture_id" \
    --arg network "testnet" \
    --arg contract_id "$contract_id" \
    --arg wasm_hash "$wasm_hash" \
    --arg class "$observed_class" \
    --arg source_archive "${source_archive#"$repo_root/"}" \
    --arg source_sha256 "$source_sha256" \
    --argjson metadata "$metadata_json" \
    '{fixture_id:$fixture_id,network:$network,contract_id:$contract_id,wasm_hash:$wasm_hash,class:$class,source_archive:$source_archive,source_sha256:$source_sha256,metadata:$metadata,validated_by:"StellarExpert contract/Wasm plus fixed GitHub source archive hash"}' \
    >> "$manifest"
}

validate_candidate \
  "public-testnet-stellaroid-earn" \
  "CAD6C24POQGRYXMBNBEGVDHUROF5ZC37XRDC6NCVILTXWMYJIBMISZCV" \
  "1b7479f1ca0f12846bbfdd8f0681670692e29e1f20618150912f010b7caf4b9f" \
  "cli-legacy" \
  "https://codeload.github.com/Iron-Mark/Hackathon-Stellaroid_Earn/tar.gz/7a67648472102d381665cb1235f003b8d114179d" \
  "66810898471a18cecf6dcf53b23de524690faee1099193b839eb6f5b186d4539" \
  "cliver=27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4" \
  "rsver=1.95.0" \
  "source_repo=github:Iron-Mark/Hackathon-Stellaroid_Earn" \
  "home_domain=stellaroid.tech"

validate_candidate \
  "public-testnet-stellaroid-2026-reference" \
  "CABV3HJFEPCREHGVFTHETSCAGPVI4O4NTCBWS5ROH6ZCWOJHNKLOO2RS" \
  "3d8d326da33e1a811853f409b13c2a9701b7e2dfa5e55f0e53b5e80c7361e4db" \
  "cli-legacy" \
  "https://codeload.github.com/armlynobinguar/Stellaroid-2026/tar.gz/4bcc503506745631411c8f31099da28a4bd2bca0" \
  "0782c6f61e7bc737356a097825b6e1c7acce71302c1d32b3214a02ba4e0ed4d7" \
  "cliver=25.2.0#28484880988199233a7e8e87c97cb12dac323cb3" \
  "rsver=1.94.0"

validate_candidate \
  "public-testnet-smart-block-explorer" \
  "CDA2ZCIB3ETZNFNQP4NS3SIEW5XCF7DKP5UWN4Y33F5FV34JA2CGAJ44" \
  "058548a781065a0f929d49acc6c738ac17ed5f2436d7e0038d3be663348f01b6" \
  "cli-none" \
  "https://codeload.github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block/tar.gz/59cdbf1a81bb5eb36304bc8897eac014fb0decab" \
  "ba4ecc43259e40928b450c1860cc88751f4b51c7110c3a7a92584dfc262ec2f8" \
  "rsver=1.99.0-nightly"

echo "validated $(wc -l < "$manifest" | tr -d ' ') public testnet candidates"
