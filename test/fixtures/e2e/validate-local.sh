#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="$repo_root/artifacts/e2e-fixtures"
archive_root="$output_root/archives"
manifest="$output_root/manifest.ndjson"
fixture_cargo_home="${SCVS_FIXTURE_CARGO_HOME:-/tmp/scvs-fixture-cargo}"
work_root="$(mktemp -d /tmp/scvs-e2e-validation.XXXXXX)"
deployed_hash="6d12d8458807f912749f72d9fb11788b2426fab7614e1a72a6ad52042977f1c0"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-validation.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ ! -f "$manifest" ]]; then
  echo "missing generated manifest; run generate-fixtures.sh first" >&2
  exit 1
fi

extract_fixture() {
  local id="$1"
  local archive="$2"
  local destination="$work_root/$id"
  mkdir -p "$destination"
  tar -xzf "$archive" -C "$destination"
  printf '%s\n' "$destination/source"
}

build_fixture() {
  local source_root="$1"
  (
    cd "$source_root"
    env CARGO_HOME="$fixture_cargo_home" \
      stellar contract build \
      --manifest-path contracts/verified-demo/Cargo.toml \
      --package verified-demo >/dev/null 2>&1
    shasum -a 256 target/wasm32v1-none/release/verified_demo.wasm | awk '{print $1}'
  )
}

jq -e -c . "$manifest" >/dev/null
duplicate_hashes="$(
  jq -s -r '
    map(select(.sha256 != null))
    | group_by(.sha256)
    | map(select(length > 1))
    | length
  ' "$manifest"
)"
if [[ "$duplicate_hashes" != "0" ]]; then
  echo "generated source archives are not distinct" >&2
  exit 1
fi

canonical_root="$(extract_fixture canonical "$archive_root/canonical-source.tar.gz")"
canonical_hash="$(build_fixture "$canonical_root")"
if [[ "$canonical_hash" != "$deployed_hash" ]]; then
  echo "canonical source produced $canonical_hash, expected $deployed_hash" >&2
  exit 1
fi

private_archive="$archive_root/private-canary.tar.gz"
private_source_hash="$(shasum -a 256 "$private_archive" | awk '{print $1}')"
if [[ "$private_source_hash" != "c35ed3d331e425ea8f397e5c2b562cd1012896c45c4282a1b96a60d87dce45dc" ]]; then
  echo "private-canary source hashes to $private_source_hash, expected the deterministic fixture hash" >&2
  exit 1
fi
if [[ "$private_source_hash" == "$(shasum -a 256 "$archive_root/canonical-source.tar.gz" | awk '{print $1}')" ]]; then
  echo "private-canary must have a source hash distinct from canonical" >&2
  exit 1
fi
private_root="$(extract_fixture private-canary "$private_archive")"
private_hash="$(build_fixture "$private_root")"
if [[ "$private_hash" != "$canonical_hash" ]]; then
  echo "private-canary source produced $private_hash, expected canonical Wasm $canonical_hash" >&2
  exit 1
fi

mismatch_root="$(extract_fixture mismatch "$archive_root/mismatch.tar.gz")"
mismatch_hash="$(build_fixture "$mismatch_root")"
if [[ "$mismatch_hash" == "$deployed_hash" ]]; then
  echo "mismatch fixture unexpectedly reproduced the deployed hash" >&2
  exit 1
fi

bulk_first_root="$(extract_fixture bulk-001 "$archive_root/bulk/bulk-001.tar.gz")"
bulk_last_root="$(extract_fixture bulk-200 "$archive_root/bulk/bulk-200.tar.gz")"
bulk_first_hash="$(build_fixture "$bulk_first_root")"
bulk_last_hash="$(build_fixture "$bulk_last_root")"
if [[ "$bulk_first_hash" == "$deployed_hash" || "$bulk_last_hash" == "$deployed_hash" ]]; then
  echo "bulk fixture unexpectedly reproduced the deployed hash" >&2
  exit 1
fi
if [[ "$bulk_first_hash" == "$bulk_last_hash" ]]; then
  echo "bulk control fixtures compiled to the same Wasm" >&2
  exit 1
fi

failed_root="$(extract_fixture build-failed "$archive_root/build-failed.tar.gz")"
if (
  cd "$failed_root"
  env CARGO_HOME="$fixture_cargo_home" \
    stellar contract build \
    --manifest-path contracts/verified-demo/Cargo.toml \
    --package verified-demo >"$work_root/build-failed.log" 2>&1
); then
  echo "build-failed fixture compiled successfully" >&2
  exit 1
fi
if ! rg -q 'expected one of|error:' "$work_root/build-failed.log"; then
  echo "build-failed fixture did not produce a recognizable compiler error" >&2
  exit 1
fi

# Do not execute this fixture here: its contract is to outlive the deployment's own wall-clock
# limit, and a local validation run has no such supervisor. Validate the two properties that make
# it deterministic and diagnosable instead — Cargo invokes the script, and the script emits the
# marker before entering an unbounded sleep loop.
timeout_root="$(extract_fixture build-timeout "$archive_root/build-timeout.tar.gz")"
timeout_manifest="$timeout_root/contracts/verified-demo/Cargo.toml"
timeout_script="$timeout_root/contracts/verified-demo/build.rs"
if ! rg -q '^build = "build\.rs"$' "$timeout_manifest"; then
  echo "build-timeout fixture does not enable build.rs" >&2
  exit 1
fi
if ! rg -q 'F-BUILD-TIMEOUT' "$timeout_script" || ! rg -q 'loop \{' "$timeout_script"; then
  echo "build-timeout fixture lacks its marker or unbounded wait" >&2
  exit 1
fi

# E2E-SRC-03/on_mismatched. Two properties, and the second is the one a reviewer would not guess:
# the archive must still compile to something that is NOT the deployed bytes (otherwise the row's
# terminal state is `verified`, not `mismatch`), and its source hash must differ from
# `mismatch.tar.gz`'s. The hash check is why the canary exists — `SRC-07` publishes
# `mismatch.tar.gz` under `sources/<hash>`, so a shared hash would leave SRC-03 unable to tell its
# own non-publication from that earlier publication.
if [[ -f "$archive_root/src03-mismatch-private.tar.gz" ]]; then
  src03_root="$(extract_fixture src03-mismatch-private "$archive_root/src03-mismatch-private.tar.gz")"
  src03_hash="$(build_fixture "$src03_root")"
  if [[ "$src03_hash" == "$deployed_hash" ]]; then
    echo "src03-mismatch-private unexpectedly reproduced the deployed hash" >&2
    exit 1
  fi
  if [[ ! -f "$src03_root/fixture-canary.txt" ]]; then
    echo "src03-mismatch-private is missing its canary, so its source hash may collide with mismatch.tar.gz" >&2
    exit 1
  fi
  src03_archive_hash="$(shasum -a 256 "$archive_root/src03-mismatch-private.tar.gz" | awk '{print $1}')"
  mismatch_archive_hash="$(shasum -a 256 "$archive_root/mismatch.tar.gz" | awk '{print $1}')"
  if [[ "$src03_archive_hash" == "$mismatch_archive_hash" ]]; then
    echo "src03-mismatch-private has the same source hash as the publicly retained mismatch archive" >&2
    exit 1
  fi
fi

plant_root="$(extract_fixture planted "$archive_root/planted-target-wasm.tar.gz")"
planted_input_hash="$(
  shasum -a 256 "$plant_root/target/wasm32v1-none/release/planted_target.wasm" | awk '{print $1}'
)"
plant_real_hash="$(build_fixture "$plant_root")"
if [[ "$planted_input_hash" != "$deployed_hash" || "$plant_real_hash" == "$deployed_hash" ]]; then
  echo "pre-build planted-Wasm control is invalid" >&2
  exit 1
fi

buildrs_root="$(extract_fixture buildrs "$archive_root/buildrs-planted-target.tar.gz")"
buildrs_real_hash="$(build_fixture "$buildrs_root")"
buildrs_payload="$buildrs_root/target/wasm32v1-none/release/planted_from_build_rs.wasm"
if [[ ! -f "$buildrs_payload" ]]; then
  echo "build.rs did not materialize its planted payload" >&2
  exit 1
fi
buildrs_payload_hash="$(shasum -a 256 "$buildrs_payload" | awk '{print $1}')"
if [[ "$buildrs_payload_hash" != "$deployed_hash" || "$buildrs_real_hash" == "$deployed_hash" ]]; then
  echo "build.rs planted-Wasm control is invalid" >&2
  exit 1
fi

traversal_entry="$(tar -tzf "$archive_root/malicious/path-traversal.tar.gz")"
symlink_entry="$(tar -tvzf "$archive_root/malicious/symlink-escape.tar.gz")"
symlink_names="$(tar -tzf "$archive_root/malicious/symlink-escape.tar.gz")"
if [[ "$traversal_entry" != "../../scvs-escape" ]]; then
  echo "path traversal archive has the wrong entry: $traversal_entry" >&2
  exit 1
fi
if [[ "$symlink_entry" != *"source/escape-link -> ../../outside"* ]]; then
  echo "symlink archive has the wrong target" >&2
  exit 1
fi
if [[ "$symlink_names" != *"source/escape-link/payload"* ]]; then
  echo "symlink archive does not contain a later write through the escaping link" >&2
  exit 1
fi

echo "local fixture validation passed"
echo "canonical=$canonical_hash"
echo "private-canary=$private_hash"
echo "mismatch=$mismatch_hash"
echo "bulk-001=$bulk_first_hash"
echo "bulk-200=$bulk_last_hash"
