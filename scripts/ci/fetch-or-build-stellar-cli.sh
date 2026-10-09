#!/usr/bin/env bash
# Ensures docker/prebuilt/bin/<arch>/stellar exists, from the S3 cache or the official release the pin names.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIN_FILE="$REPO_ROOT/docker/stellar-cli.pin"
# shellcheck disable=SC1090
source "$PIN_FILE"

: "${STELLAR_CLI_VERSION:?docker/stellar-cli.pin must set STELLAR_CLI_VERSION}"

S3_BUCKET="${SCVS_CI_CACHE_BUCKET:-}"
AWS_REGION="${AWS_REGION:-ap-southeast-2}"

SCVS_CI_CACHE="${SCVS_CI_CACHE:-s3}"

if [ "$SCVS_CI_CACHE" != "off" ] && [ -z "$S3_BUCKET" ]; then
  echo "[fetch-or-build-stellar-cli] SCVS_CI_CACHE_BUCKET is unset — name the cache bucket, or set SCVS_CI_CACHE=off" >&2
  exit 1
fi

case "${SCVS_CLI_TARGET_ARCH:-$(uname -m)}" in
  arm64 | aarch64) TARGET_ARCH=arm64; TARGET_TRIPLE=aarch64-unknown-linux-gnu ;;
  amd64 | x86_64) TARGET_ARCH=amd64; TARGET_TRIPLE=x86_64-unknown-linux-gnu ;;
  *)
    echo "[fetch-or-build-stellar-cli] unsupported architecture: ${SCVS_CLI_TARGET_ARCH:-$(uname -m)}" >&2
    echo "  set SCVS_CLI_TARGET_ARCH to arm64 or amd64" >&2
    exit 1
    ;;
esac

ASSET_VERSION="${STELLAR_CLI_VERSION#v}"
ASSET_NAME="${STELLAR_CLI_ASSET_TEMPLATE/\{version\}/$ASSET_VERSION}"
ASSET_NAME="${ASSET_NAME/\{triple\}/$TARGET_TRIPLE}"
ASSET_URL="https://github.com/stellar/stellar-cli/releases/download/${STELLAR_CLI_VERSION}/${ASSET_NAME}"

arch_upper="$(printf '%s' "$TARGET_ARCH" | tr '[:lower:]' '[:upper:]')"
tarball_var="STELLAR_CLI_TARBALL_SHA256_${arch_upper}"
binary_var="STELLAR_CLI_BINARY_SHA256_${arch_upper}"
EXPECTED_TARBALL_SHA256="${!tarball_var:?docker/stellar-cli.pin must set $tarball_var}"
EXPECTED_BINARY_SHA256="${!binary_var:?docker/stellar-cli.pin must set $binary_var}"

CACHE_KEY="scvs-ci/stellar-cli/${STELLAR_CLI_VERSION}/${TARGET_ARCH}/stellar"

# Per-architecture; the Dockerfiles COPY through ${TARGETARCH} to match.
OUT_DIR="$REPO_ROOT/docker/prebuilt/bin/${TARGET_ARCH}"
mkdir -p "$OUT_DIR"

echo "[fetch-or-build-stellar-cli] version:   ${STELLAR_CLI_VERSION}"
echo "[fetch-or-build-stellar-cli] target:    ${TARGET_ARCH} (${TARGET_TRIPLE})"
echo "[fetch-or-build-stellar-cli] cache key: s3://${S3_BUCKET}/${CACHE_KEY}"

assert_pinned_binary() {
  local actual
  actual="$(shasum -a 256 "$OUT_DIR/stellar" | awk '{print $1}')"
  if [ "$actual" != "$EXPECTED_BINARY_SHA256" ]; then
    echo "[fetch-or-build-stellar-cli] BINARY DIGEST MISMATCH — refusing to hand this binary on" >&2
    echo "    expected ${EXPECTED_BINARY_SHA256}  (docker/stellar-cli.pin, ${binary_var})" >&2
    echo "    actual   ${actual}" >&2
    echo "    source   ${1}" >&2
    exit 1
  fi
  echo "[fetch-or-build-stellar-cli] binary digest matches the pin (${1})"
}

# Probe the bucket first: `head-object` answers 404 for a missing bucket exactly as for an absent key.
if [ "$SCVS_CI_CACHE" = "off" ]; then
  echo "[fetch-or-build-stellar-cli] SCVS_CI_CACHE=off — downloading the official release directly"
elif ! bucket_error="$(aws s3api head-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" 2>&1 >/dev/null)"; then
  echo "[fetch-or-build-stellar-cli] the cache is unreachable, which is NOT the same as a miss:" >&2
  echo "    ${bucket_error}" >&2
  echo "  bucket: s3://${S3_BUCKET}   (override with SCVS_CI_CACHE_BUCKET)" >&2
  echo "  A 404 here means the bucket is gone or renamed; a 403 means the CI role lost" >&2
  echo "  s3:ListBucket on it." >&2
  exit 1
fi

if [ "$SCVS_CI_CACHE" != "off" ] && aws s3api head-object \
     --bucket "$S3_BUCKET" --key "$CACHE_KEY" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "[fetch-or-build-stellar-cli] cache hit — downloading"
  aws s3 cp "s3://${S3_BUCKET}/${CACHE_KEY}" "$OUT_DIR/stellar" --region "$AWS_REGION"
  chmod +x "$OUT_DIR/stellar"
  assert_pinned_binary "S3 cache"
  (cd "$OUT_DIR" && shasum -a 256 stellar > stellar.sha256)
  exit 0
fi

echo "[fetch-or-build-stellar-cli] cache miss — downloading the official release"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
curl --fail --location --silent --show-error --retry 3 --retry-connrefused \
  --output "$STAGE/$ASSET_NAME" "$ASSET_URL"

actual_tarball="$(shasum -a 256 "$STAGE/$ASSET_NAME" | awk '{print $1}')"
if [ "$actual_tarball" != "$EXPECTED_TARBALL_SHA256" ]; then
  echo "[fetch-or-build-stellar-cli] TARBALL DIGEST MISMATCH — refusing to unpack" >&2
  echo "    url      ${ASSET_URL}" >&2
  echo "    expected ${EXPECTED_TARBALL_SHA256}  (docker/stellar-cli.pin, ${tarball_var})" >&2
  echo "    actual   ${actual_tarball}" >&2
  echo "  Either the pin is stale or the asset was replaced. Do not 'fix' this by updating the" >&2
  echo "  digest without establishing which." >&2
  exit 1
fi
echo "[fetch-or-build-stellar-cli] tarball digest matches the pin"

tar -xzf "$STAGE/$ASSET_NAME" -C "$STAGE" stellar
cp "$STAGE/stellar" "$OUT_DIR/stellar"
chmod +x "$OUT_DIR/stellar"
assert_pinned_binary "official release"
(cd "$OUT_DIR" && shasum -a 256 stellar > stellar.sha256)

if [ "$SCVS_CI_CACHE" = "off" ] || [ "${SCVS_CI_CACHE_UPLOAD:-1}" = "0" ]; then
  echo "[fetch-or-build-stellar-cli] cache writes disabled — leaving the cache untouched"
else
  echo "[fetch-or-build-stellar-cli] uploading to cache for next time"
  aws s3 cp "$OUT_DIR/stellar" "s3://${S3_BUCKET}/${CACHE_KEY}" --region "$AWS_REGION"
fi
