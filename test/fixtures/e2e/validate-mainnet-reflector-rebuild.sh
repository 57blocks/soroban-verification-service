#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
expected_wasm="25fc306065cbb9b05461db78ec259802cb916053ba5b3ab911b0a72dd1a81439"
expected_source="0cf8b099723e5060d298d5c7c45dd92f3727dbf0c09cb39c83286f8295cbd369"
cliver="28.1.0#c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd"
rsver="1.99.0"
rustup_toolchain="1.99.0-aarch64-unknown-linux-gnu"
image="scvs-composed:template-gate-v3"
source_url="https://api.github.com/repos/reflector-network/reflector-contract/tarball/6fece3b6efab3c855e920c450e3a2822f14df405"
work_root="$(mktemp -d /tmp/scvs-reflector-rebuild.XXXXXX)"

cleanup() {
  if [[ "${SCVS_KEEP_REBUILD_WORKDIR:-}" == "1" ]]; then
    echo "kept rebuild work directory: $work_root"
    return
  fi

  case "$work_root" in
    /tmp/scvs-reflector-rebuild.*) rm -rf "$work_root" ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

for command in curl docker find mktemp node shasum tar; do
  command -v "$command" >/dev/null || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

echo "==> composing and smoke-testing $cliver / $rsver"
(
  cd "$repo_root"
  node eng-tools/check-composition-template.mjs \
    --cliver "$cliver" \
    --rsver "$rsver" \
    --keep-image
)

mkdir -p "$work_root/source" "$work_root/vendor" "$work_root/out/cargo-home" "$work_root/out/tmp"

echo "==> downloading fixed Reflector source"
curl --fail --location --retry 3 --output "$work_root/source.tar.gz" "$source_url"
actual_source="$(shasum -a 256 "$work_root/source.tar.gz" | awk '{print $1}')"
if [[ "$actual_source" != "$expected_source" ]]; then
  echo "source SHA-256 $actual_source, expected $expected_source" >&2
  exit 1
fi
echo "    source SHA-256: $actual_source"

tar -xzf "$work_root/source.tar.gz" --strip-components=1 -C "$work_root/source"
chmod -R a+rX "$work_root/source"
chmod -R a+rwx "$work_root/vendor" "$work_root/out"

echo "==> vendoring Cargo.lock dependencies"
docker run --rm \
  --user 1000:1000 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --entrypoint cargo \
  -v "$work_root/source:/source:ro" \
  -v "$work_root/vendor:/vendor" \
  -v "$work_root/out:/out" \
  -w /source \
  -e CARGO_HOME=/out/cargo-home \
  -e RUSTUP_TOOLCHAIN="$rustup_toolchain" \
  "$image" \
  vendor --locked --manifest-path /source/Cargo.toml /vendor

# Written only after `cargo vendor`: the offline source redirect would block its download.
cat > "$work_root/out/cargo-home/config.toml" <<'EOF'
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "/vendor"

[net]
offline = true
EOF

echo "==> rebuilding with no container network"
docker run --rm \
  --user 1000:1000 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  -v "$work_root/source:/source:ro" \
  -v "$work_root/vendor:/vendor:ro" \
  -v "$work_root/out:/out" \
  -w /source \
  -e CARGO_HOME=/out/cargo-home \
  -e CARGO_NET_OFFLINE=true \
  -e CARGO_TARGET_DIR=/out/target \
  -e TMPDIR=/out/tmp \
  -e RUSTUP_TOOLCHAIN="$rustup_toolchain" \
  "$image" \
  contract build \
  --package=reflector-pulse-contract \
  --meta=source_repo=github:reflector-network/reflector-contract \
  --optimize

wasm="$(find "$work_root/out/target/wasm32v1-none/release" -maxdepth 1 -type f -name '*.wasm' -print -quit)"
if [[ -z "$wasm" ]]; then
  echo "stellar contract build exited successfully but produced no top-level release Wasm" >&2
  exit 1
fi

actual_wasm="$(shasum -a 256 "$wasm" | awk '{print $1}')"
echo "==> result"
echo "    Wasm: $wasm"
echo "    SHA-256: $actual_wasm"
echo "    Expected: $expected_wasm"

if [[ "$actual_wasm" != "$expected_wasm" ]]; then
  echo "MISMATCH: do not promote F-LEG-1-MAINNET" >&2
  exit 1
fi

echo "MATCH: safe to promote F-LEG-1-MAINNET and enable E2E-SUB-01/mainnet"
