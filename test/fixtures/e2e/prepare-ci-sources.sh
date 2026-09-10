#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
archive_root="$repo_root/artifacts/e2e-fixtures/archives"
inventory="${SCVS_E2E_FIXTURES:-$repo_root/test/integration/fixtures/e2e-fixtures.dev.json}"
tar_bin="${SCVS_FIXTURE_TAR_BIN:-tar}"
zip_bin="${SCVS_FIXTURE_ZIP_BIN:-}"
work_root="$(mktemp -d /tmp/scvs-e2e-ci-sources.XXXXXX)"
source_url="https://raw.githubusercontent.com/jia57b/soroban-contract/main/ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533.tar.gz"
canonical_input="${SCVS_E2E_CANONICAL_SOURCE_ARCHIVE:-}"
multi_package_source="$repo_root/test/fixtures/sample-contracts/multi-package-workspace"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-ci-sources.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

for command in curl gzip jq perl shasum; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
command -v "$tar_bin" >/dev/null || {
  echo "missing tar implementation: $tar_bin" >&2
  exit 1
}
if [[ -z "$zip_bin" ]]; then
  if command -v bsdtar >/dev/null; then
    zip_bin="bsdtar"
  elif command -v zip >/dev/null; then
    zip_bin="zip"
  else
    echo "missing ZIP implementation: install bsdtar or zip, or set SCVS_FIXTURE_ZIP_BIN" >&2
    exit 1
  fi
fi
command -v "$zip_bin" >/dev/null || {
  echo "missing ZIP implementation: $zip_bin" >&2
  exit 1
}

if "$tar_bin" --version 2>&1 | grep --quiet "GNU tar"; then
  tar_owner_args=(--owner=root --group=root)
else
  tar_owner_args=(--uid 0 --gid 0 --uname root --gname root)
fi

if [[ "$inventory" != /* ]]; then
  inventory="$repo_root/$inventory"
fi
if [[ ! -f "$inventory" ]]; then
  echo "fixture inventory does not exist: $inventory" >&2
  exit 1
fi

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

assert_hash() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(sha256_file "$path")"
  if [[ "$actual" != "$expected" ]]; then
    if [[ "${SCVS_FIXTURE_ALLOW_PLATFORM_HASH:-}" == "1" ]]; then
      echo "$path uses platform archive hash $actual (inventory template has $expected)" >&2
      return 0
    fi
    echo "$path hashes to $actual, expected $expected" >&2
    exit 1
  fi
}

package_variant() {
  local replacement="$1"
  local output="$2"
  local expected_hash="$3"
  local tree="$work_root/variant-$(basename "$output" .tar.gz)"
  local source_file

  cp -R "$work_root/base" "$tree"
  source_file="$tree/source/contracts/verified-demo/src/lib.rs"
  if ! grep -q '"Hello"' "$source_file"; then
    echo "canonical source no longer contains the expected greeting: $source_file" >&2
    exit 1
  fi
  REPLACEMENT="$replacement" perl -0pi -e 's/"Hello"/"$ENV{REPLACEMENT}"/' "$source_file"

  mkdir -p "$(dirname "$output")"
  (
    cd "$tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
      | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion \
          "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$output"
  )
  assert_hash "$output" "$expected_hash"
}

package_private_canary() {
  local output="$1"
  local expected_hash="$2"
  local tree="$work_root/private-canary"

  cp -R "$work_root/base" "$tree"
  printf 'SCVS-PRIVATE-CANARY-20260803\n' > "$tree/source/fixture-canary.txt"
  mkdir -p "$(dirname "$output")"
  (
    cd "$tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
      | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion \
          "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$output"
  )
  assert_hash "$output" "$expected_hash"
}

package_src03_private_mismatch() {
  local output="$1"
  local expected_hash="$2"
  local tree="$work_root/src03-mismatch-private"
  local source_file

  cp -R "$work_root/base" "$tree"
  source_file="$tree/source/contracts/verified-demo/src/lib.rs"
  if ! grep -q '"Hello"' "$source_file"; then
    echo "canonical source no longer contains the expected greeting: $source_file" >&2
    exit 1
  fi
  perl -0pi -e 's/"Hello"/"Fixture mismatch"/' "$source_file"
  printf 'SCVS-SRC03-MISMATCH-CANARY-20260820\n' > "$tree/source/fixture-canary.txt"
  mkdir -p "$(dirname "$output")"
  (
    cd "$tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
      | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion \
          "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$output"
  )
  assert_hash "$output" "$expected_hash"
}

package_multi_package() {
  local output="$1"
  local expected_hash="$2"
  local tree="$work_root/multi-package"

  mkdir -p "$tree/source" "$(dirname "$output")"
  cp -R "$multi_package_source/." "$tree/source/"
  rm -rf "$tree/source/target"
  rm -f "$tree/source/README.md" "$tree/source/.DS_Store"
  (
    cd "$tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
      | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion \
          "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$output"
  )
  assert_hash "$output" "$expected_hash"
}

# A ZIP made from the source directory itself, as Finder's Compress produces when pointed at a
# project folder. It has no nested archive.
package_source_tree_zip() {
  local output="$1"
  local canary="$2"
  local tree="$work_root/source-tree-zip-$(basename "$output" .zip)"

  cp -R "$work_root/base" "$tree"
  printf '%s\n' "$canary" > "$tree/source/fixture-zip-canary.txt"
  # source_sha256 is recorded in the fixture's immutable on-chain recipe, so the ZIP's byte layout
  # must not inherit this machine's extraction time or directory enumeration order.
  find "$tree/source" -exec touch -t 202001010000 {} +
  mkdir -p "$(dirname "$output")"
  if [[ "$(basename "$zip_bin")" == "bsdtar" ]]; then
    (
      cd "$tree"
      LC_ALL=C find source -print | LC_ALL=C sort | "$zip_bin" --format zip -cf "$output" -T -
    )
  else
    (
      cd "$tree"
      LC_ALL=C find source -print | LC_ALL=C sort | "$zip_bin" -X -q "$output" -@
    )
  fi
}

mkdir -p "$archive_root"
canonical_archive="$archive_root/canonical-source.tar.gz"
canonical_hash="$(jq -er '.contracts["F-LEG-1"].source_sha256' "$inventory")"
downloaded_archive="$work_root/canonical-source.tar.gz"
if [[ -n "$canonical_input" ]]; then
  if [[ "$canonical_input" != /* ]]; then
    canonical_input="$repo_root/$canonical_input"
  fi
  cp "$canonical_input" "$downloaded_archive"
else
  curl -L --fail --silent --show-error \
    --connect-timeout 15 --max-time 120 --retry 3 --retry-all-errors \
    -o "$downloaded_archive" "$source_url"
fi
assert_hash "$downloaded_archive" "$canonical_hash"
cp "$downloaded_archive" "$canonical_archive"

mkdir -p "$work_root/base"
"$tar_bin" -xzf "$canonical_archive" -C "$work_root/base"
zip_scope="${SCVS_FIXTURE_DEPLOYMENT_SCOPE:-local}"
zip_scope_digest="$(printf '%s' "$zip_scope" | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
package_source_tree_zip "$archive_root/f58-source-tree.zip" "SCVS-F58-ZIP-CANARY-$zip_scope_digest"
package_source_tree_zip "$archive_root/f58-public-source-tree.zip" "SCVS-F58-ZIP-PUBLIC-CANARY-$zip_scope_digest"

mismatch_hash="$(jq -er '.contracts["F-LEG-3"].source_sha256' "$inventory")"
package_variant \
  "Fixture mismatch" \
  "$archive_root/mismatch.tar.gz" \
  "$mismatch_hash"

bulk_hash="$(jq -er '.contracts["F-MISMATCH-ALT"].source_sha256' "$inventory")"
package_variant \
  "Bulk-001" \
  "$archive_root/bulk/bulk-001.tar.gz" \
  "$bulk_hash"

private_hash="$(jq -er '.contracts["F-PRIV"].source_sha256' "$inventory")"
package_private_canary \
  "$archive_root/private-canary.tar.gz" \
  "$private_hash"

src03_mismatch_hash="$(jq -er '.contracts["F-PRIV-MISMATCH"].source_sha256' "$inventory")"
package_src03_private_mismatch \
  "$archive_root/src03-mismatch-private.tar.gz" \
  "$src03_mismatch_hash"

multi_package_hash="$(jq -er '.contracts["F-MULTIPKG"].source_sha256' "$inventory")"
package_multi_package \
  "$archive_root/multi-package-source.tar.gz" \
  "$multi_package_hash"

echo "prepared and verified canonical, private/public ZIP source trees, private-canary, src03-mismatch-private, mismatch, bulk-001, and multi-package E2E source archives"
