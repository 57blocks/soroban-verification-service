#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="$repo_root/artifacts/e2e-fixtures"
archive_root="$output_root/archives/upgrade"
manifest="$output_root/purpose-built-wasm.ndjson"
image="docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43"
docker_cargo="/tmp/scvs-e2e-official-cargo"
work_root="$(mktemp -d /tmp/scvs-e2e-upgrade-validation.XXXXXX)"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-upgrade-validation.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

for command in docker jq shasum; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

for version in 1 2; do
  fixture_id="F-UPG-v$version"
  archive="$archive_root/f-upg-v$version-source.tar.gz"
  source_root="$work_root/v$version"
  expected_hash="$(
    jq -r --arg fixture_id "$fixture_id" \
      'select(.fixture_id == $fixture_id) | .wasm_hash' "$manifest"
  )"
  expected_source_hash="$(
    jq -r --arg fixture_id "$fixture_id" \
      'select(.fixture_id == $fixture_id) | .source_sha256' "$manifest"
  )"
  actual_source_hash="$(shasum -a 256 "$archive" | awk '{print $1}')"
  if [[ -z "$expected_hash" || "$actual_source_hash" != "$expected_source_hash" ]]; then
    echo "$fixture_id manifest does not match its source archive" >&2
    exit 1
  fi

  mkdir -p "$source_root"
  tar -xzf "$archive" -C "$source_root"
  docker run --rm \
    -v "$docker_cargo:/stellar/.cargo" \
    -v "$source_root/source:/source" \
    -w /source \
    "$image" \
      contract build \
      --locked \
      --manifest-path=contracts/verified-demo/Cargo.toml \
      --package=verified-demo \
      --optimize >/dev/null
  actual_hash="$(
    shasum -a 256 "$source_root/source/target/wasm32v1-none/release/verified_demo.wasm" \
      | awk '{print $1}'
  )"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    echo "$fixture_id source produced $actual_hash, expected $expected_hash" >&2
    exit 1
  fi
  echo "$fixture_id source reproduced $actual_hash"
done
