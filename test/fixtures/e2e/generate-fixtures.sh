#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="$repo_root/artifacts/e2e-fixtures"
archive_root="$output_root/archives"
wasm_root="$output_root/wasm"
manifest="$output_root/manifest.ndjson"
tar_bin="${SCVS_FIXTURE_TAR_BIN:-tar}"
work_root="$(mktemp -d /tmp/scvs-e2e-fixtures.XXXXXX)"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-fixtures.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

for command in curl jq perl shasum stellar xxd; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done
command -v "$tar_bin" >/dev/null || {
  echo "missing tar implementation: $tar_bin" >&2
  exit 1
}

if "$tar_bin" --version 2>&1 | grep --quiet "GNU tar"; then
  tar_owner_args=(--owner=root --group=root)
else
  tar_owner_args=(--uid 0 --gid 0 --uname root --gname root)
fi

for variable in SCVS_FIXTURE_TAR_ENTRY_LIMIT SCVS_FIXTURE_UNCOMPRESSED_LIMIT; do
  value="${!variable:-}"
  if [[ -n "$value" && ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$variable must be a positive integer" >&2
    exit 1
  fi
done

mkdir -p "$archive_root" "$wasm_root"
: > "$manifest"

source_url="https://raw.githubusercontent.com/jia57b/soroban-contract/main/ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533.tar.gz"
source_sha="ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533"
legacy_contract="CDFI5WMI7VA6YO5TKM7AI4CGQGYYT45UDQFMDKGN5Q22S2SLCI6RT4RM"
legacy_wasm_sha="6d12d8458807f912749f72d9fb11788b2426fab7614e1a72a6ad52042977f1c0"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

record_archive() {
  local id="$1"
  local intent="$2"
  local path="$3"
  local hash
  local bytes
  hash="$(sha256_file "$path")"
  bytes="$(wc -c < "$path" | tr -d ' ')"
  jq -nc \
    --arg id "$id" \
    --arg intent "$intent" \
    --arg path "${path#"$repo_root/"}" \
    --arg sha256 "$hash" \
    --argjson bytes "$bytes" \
    '{id:$id,intent:$intent,path:$path,sha256:$sha256,bytes:$bytes}' >> "$manifest"
}

clone_base() {
  local destination="$1"
  cp -R "$work_root/base" "$destination"
}

package_tree() {
  local tree="$1"
  local output="$2"
  (
    cd "$tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
      | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion \
          "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$output"
  )
}

enable_build_script() {
  local cargo_toml="$1"
  perl -0pi -e 's/\[package\]\n/\[package\]\nbuild = "build.rs"\n/' "$cargo_toml"
}

canonical_archive="$archive_root/canonical-source.tar.gz"
curl -L --fail --silent --show-error -o "$canonical_archive" "$source_url"
actual_source_sha="$(sha256_file "$canonical_archive")"
if [[ "$actual_source_sha" != "$source_sha" ]]; then
  echo "source archive hash mismatch: expected $source_sha, got $actual_source_sha" >&2
  exit 1
fi
record_archive "canonical" "known source for existing testnet contracts" "$canonical_archive"

mkdir -p "$work_root/base"
"$tar_bin" -xzf "$canonical_archive" -C "$work_root/base"

legacy_wasm="$wasm_root/existing-testnet-cli-legacy.wasm"
stellar contract fetch --id "$legacy_contract" --network testnet --out-file "$legacy_wasm"
actual_wasm_sha="$(sha256_file "$legacy_wasm")"
if [[ "$actual_wasm_sha" != "$legacy_wasm_sha" ]]; then
  echo "deployed Wasm hash mismatch: expected $legacy_wasm_sha, got $actual_wasm_sha" >&2
  exit 1
fi

mismatch_tree="$work_root/mismatch"
clone_base "$mismatch_tree"
perl -0pi -e 's/"Hello"/"Fixture mismatch"/' \
  "$mismatch_tree/source/contracts/verified-demo/src/lib.rs"
mismatch_archive="$archive_root/mismatch.tar.gz"
package_tree "$mismatch_tree" "$mismatch_archive"
record_archive "mismatch" "compiles but must not match the deployed target" "$mismatch_archive"

failed_tree="$work_root/build-failed"
clone_base "$failed_tree"
printf '\nthis is not valid rust\n' >> "$failed_tree/source/contracts/verified-demo/src/lib.rs"
failed_archive="$archive_root/build-failed.tar.gz"
package_tree "$failed_tree" "$failed_archive"
record_archive "build-failed" "produces a real rustc error" "$failed_archive"

timeout_tree="$work_root/build-timeout"
clone_base "$timeout_tree"
enable_build_script "$timeout_tree/source/contracts/verified-demo/Cargo.toml"
cat > "$timeout_tree/source/contracts/verified-demo/build.rs" <<'BUILD_RS'
use std::{thread, time::Duration};

fn main() {
    eprintln!("[F-BUILD-TIMEOUT] build.rs entered deliberate wall-clock wait");
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}
BUILD_RS
timeout_archive="$archive_root/build-timeout.tar.gz"
package_tree "$timeout_tree" "$timeout_archive"
record_archive "build-timeout" "build.rs exceeds the deployment wall-clock limit" "$timeout_archive"

private_tree="$work_root/private"
clone_base "$private_tree"
printf 'SCVS-PRIVATE-CANARY-20260803\n' > "$private_tree/source/fixture-canary.txt"
private_archive="$archive_root/private-canary.tar.gz"
package_tree "$private_tree" "$private_archive"
record_archive "private-canary" "private upload retention and backup search" "$private_archive"

# E2E-SRC-03/on_mismatched. The mismatch edit plus a canary the build never reads, which is the whole
# point: the verdict stays `mismatched` while the source hash diverges from `mismatch.tar.gz`. That
# divergence is load-bearing rather than tidy — `SRC-07` submits `mismatch.tar.gz` with
# `is_public: true`, so its bytes are retained under `sources/<hash>`, and an SRC-03 row reusing that
# hash could not tell "this private submission was not published" from "a public case published the
# same archive earlier". Same reason `private-canary` above exists rather than reusing the canonical
# source.
src03_mismatch_tree="$work_root/src03-mismatch-private"
clone_base "$src03_mismatch_tree"
perl -0pi -e 's/"Hello"/"Fixture mismatch"/' \
  "$src03_mismatch_tree/source/contracts/verified-demo/src/lib.rs"
printf 'SCVS-SRC03-MISMATCH-CANARY-20260820\n' > "$src03_mismatch_tree/source/fixture-canary.txt"
src03_mismatch_archive="$archive_root/src03-mismatch-private.tar.gz"
package_tree "$src03_mismatch_tree" "$src03_mismatch_archive"
record_archive "src03-mismatch-private" \
  "private-only mismatch with a source hash distinct from the publicly retained mismatch archive" \
  "$src03_mismatch_archive"

toolchain_tree="$work_root/toolchain-selector"
clone_base "$toolchain_tree"
printf '[toolchain]\nchannel = "1.99.0"\nprofile = "minimal"\n' \
  > "$toolchain_tree/source/rust-toolchain.toml"
toolchain_archive="$archive_root/toolchain-selector.tar.gz"
package_tree "$toolchain_tree" "$toolchain_archive"
record_archive "toolchain-selector" "source attempts to replace the image toolchain" "$toolchain_archive"

egress_tree="$work_root/egress"
clone_base "$egress_tree"
enable_build_script "$egress_tree/source/contracts/verified-demo/Cargo.toml"
cat > "$egress_tree/source/contracts/verified-demo/build.rs" <<'BUILD_RS'
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

fn main() {
    let endpoint = "fixture-egress.invalid:443";
    let result = endpoint
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok());
    println!("cargo:warning=[F-ADV-EGRESS] connected={}", result.is_some());
    if result.is_none() {
        panic!("fixture network request was blocked");
    }
}
BUILD_RS
egress_archive="$archive_root/build-egress.tar.gz"
package_tree "$egress_tree" "$egress_archive"
record_archive "build-egress" "build.rs attempts stage-two network egress" "$egress_archive"

plant_tree="$work_root/planted"
clone_base "$plant_tree"
perl -0pi -e 's/"Hello"/"Plant control"/' \
  "$plant_tree/source/contracts/verified-demo/src/lib.rs"
mkdir -p "$plant_tree/source/target/wasm32v1-none/release"
cp "$legacy_wasm" "$plant_tree/source/target/wasm32v1-none/release/planted_target.wasm"
touch -t 203801010000 "$plant_tree/source/target/wasm32v1-none/release/planted_target.wasm"
plant_archive="$archive_root/planted-target-wasm.tar.gz"
package_tree "$plant_tree" "$plant_archive"
record_archive "planted-target-wasm" "prebuilt target bytes coexist with real build output" "$plant_archive"

buildrs_tree="$work_root/buildrs-plant"
clone_base "$buildrs_tree"
perl -0pi -e 's/"Hello"/"Build script control"/' \
  "$buildrs_tree/source/contracts/verified-demo/src/lib.rs"
enable_build_script "$buildrs_tree/source/contracts/verified-demo/Cargo.toml"
payload_hex="$(xxd -p "$legacy_wasm" | tr -d '\n')"
cat > "$buildrs_tree/source/contracts/verified-demo/build.rs" <<BUILD_RS
use std::{env, fs, path::PathBuf};

fn main() {
    let hex = "$payload_hex";
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex payload"))
        .collect();
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"))
        .join("../../../planted_from_build_rs.wasm");
    let result = fs::write(&output, bytes);
    println!("cargo:warning=[F-ADV-BUILDRS] plant path={}", output.display());
    println!("cargo:warning=[F-ADV-BUILDRS] plant result={result:?}");
}
BUILD_RS
buildrs_archive="$archive_root/buildrs-planted-target.tar.gz"
package_tree "$buildrs_tree" "$buildrs_archive"
record_archive "buildrs-planted-target" "build.rs materializes embedded target bytes" "$buildrs_archive"

bulk_root="$archive_root/bulk"
mkdir -p "$bulk_root"
for sequence in $(seq 1 200); do
  suffix="$(printf '%03d' "$sequence")"
  bulk_tree="$work_root/bulk-$suffix"
  clone_base "$bulk_tree"
  perl -0pi -e "s/\"Hello\"/\"Bulk-$suffix\"/" \
    "$bulk_tree/source/contracts/verified-demo/src/lib.rs"
  bulk_archive="$bulk_root/bulk-$suffix.tar.gz"
  package_tree "$bulk_tree" "$bulk_archive"
  record_archive "bulk-$suffix" "distinct compilable mismatch candidate" "$bulk_archive"
done

malicious_root="$archive_root/malicious"
mkdir -p "$malicious_root"
mkdir -p "$work_root/tar-traversal"
printf 'path traversal fixture\n' > "$work_root/tar-traversal/payload"
touch -t 202001010000 "$work_root/tar-traversal/payload"
COPYFILE_DISABLE=1 "$tar_bin" --format ustar "${tar_owner_args[@]}" -cf - \
  -C "$work_root/tar-traversal" -s ',payload,../../scvs-escape,' payload \
  | gzip -n > "$malicious_root/path-traversal.tar.gz"
record_archive "tar-path-traversal" "archive entry escapes extraction root" \
  "$malicious_root/path-traversal.tar.gz"

mkdir -p "$work_root/tar-symlink/source"
ln -s ../../outside "$work_root/tar-symlink/source/escape-link"
touch -t 202001010000 "$work_root/tar-symlink/source"
touch -h -t 202001010000 "$work_root/tar-symlink/source/escape-link"
mkdir -p "$work_root/tar-symlink-payload"
printf 'symlink escape fixture\n' > "$work_root/tar-symlink-payload/payload"
touch -t 202001010000 "$work_root/tar-symlink-payload/payload"
COPYFILE_DISABLE=1 "$tar_bin" --format ustar "${tar_owner_args[@]}" \
  -cf "$work_root/symlink-escape.tar" \
  -C "$work_root/tar-symlink" source
COPYFILE_DISABLE=1 "$tar_bin" --format ustar "${tar_owner_args[@]}" \
  -rf "$work_root/symlink-escape.tar" \
  -C "$work_root/tar-symlink-payload" \
  -s ',payload,source/escape-link/payload,' payload
gzip -n < "$work_root/symlink-escape.tar" > "$malicious_root/symlink-escape.tar.gz"
record_archive "tar-symlink-escape" "archive contains an escaping symlink" \
  "$malicious_root/symlink-escape.tar.gz"

if [[ -n "${SCVS_FIXTURE_TAR_ENTRY_LIMIT:-}" ]]; then
  file_count="$SCVS_FIXTURE_TAR_ENTRY_LIMIT"
  mkdir -p "$work_root/tar-entry-bomb/source"
  for sequence in $(seq 1 "$file_count"); do
    : > "$work_root/tar-entry-bomb/source/$sequence"
  done
  find "$work_root/tar-entry-bomb/source" -exec touch -t 202001010000 {} +
  COPYFILE_DISABLE=1 "$tar_bin" --format ustar "${tar_owner_args[@]}" -cf - \
    -C "$work_root/tar-entry-bomb" source \
    | gzip -n > "$malicious_root/entry-count-bomb.tar.gz"
  record_archive "tar-entry-count-bomb" "policy limit plus one archive entries" \
    "$malicious_root/entry-count-bomb.tar.gz"
fi

if [[ -n "${SCVS_FIXTURE_UNCOMPRESSED_LIMIT:-}" ]]; then
  expanded_bytes=$((SCVS_FIXTURE_UNCOMPRESSED_LIMIT + 1))
  mkdir -p "$work_root/tar-size-bomb/source"
  perl -e 'truncate STDOUT, $ARGV[0] or die $!' "$expanded_bytes" \
    > "$work_root/tar-size-bomb/source/expanded.bin"
  find "$work_root/tar-size-bomb/source" -exec touch -t 202001010000 {} +
  COPYFILE_DISABLE=1 "$tar_bin" --format ustar "${tar_owner_args[@]}" -cf - \
    -C "$work_root/tar-size-bomb" source \
    | gzip -n > "$malicious_root/expanded-size-bomb.tar.gz"
  record_archive "tar-expanded-size-bomb" "policy expanded-size limit plus one byte" \
    "$malicious_root/expanded-size-bomb.tar.gz"
fi

wrong_sha="$(printf '0%.0s' $(seq 1 64))"
jq -nc \
  --arg id "source-sha-mismatch" \
  --arg archive_sha256 "$source_sha" \
  --arg declared_source_sha256 "$wrong_sha" \
  '{id:$id,intent:"valid bytes with an incorrect declared source_sha256",archive_sha256:$archive_sha256,declared_source_sha256:$declared_source_sha256}' \
  >> "$manifest"

echo "generated $(wc -l < "$manifest" | tr -d ' ') fixture records in ${output_root#"$repo_root/"}"
