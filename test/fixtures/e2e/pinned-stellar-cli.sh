#!/usr/bin/env bash

scvs_pinned_stellar_cli() {
  local repo_root="$1"
  local cache_root="${SCVS_FIXTURE_STELLAR_CACHE_DIR:-$repo_root/artifacts/e2e-fixtures/stellar-cli-cache}"
  local pin_file="$repo_root/docker/stellar-cli.pin"
  local platform arch triple suffix cache_dir cli_bin
  local asset_version asset_name asset_url stage actual

  if [[ -n "${SCVS_FIXTURE_STELLAR_BIN:-}" ]]; then
    printf '%s\n' "$SCVS_FIXTURE_STELLAR_BIN"
    return
  fi

  # shellcheck disable=SC1090
  source "$pin_file"
  : "${STELLAR_CLI_VERSION:?docker/stellar-cli.pin must set STELLAR_CLI_VERSION}"

  case "$(uname -s)" in
    Darwin) platform=apple-darwin;      suffix=DARWIN_ ;;
    Linux)  platform=unknown-linux-gnu; suffix=        ;;
    *)
      echo "scvs_pinned_stellar_cli: unsupported host OS $(uname -s) — set SCVS_FIXTURE_STELLAR_BIN" >&2
      return 1
      ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=ARM64; triple="aarch64-${platform}" ;;
    x86_64 | amd64)  arch=AMD64; triple="x86_64-${platform}" ;;
    *)
      echo "scvs_pinned_stellar_cli: unsupported host architecture $(uname -m) — set SCVS_FIXTURE_STELLAR_BIN" >&2
      return 1
      ;;
  esac

  local tarball_var="STELLAR_CLI_TARBALL_SHA256_${suffix}${arch}"
  local binary_var="STELLAR_CLI_BINARY_SHA256_${suffix}${arch}"
  local expected_tarball="${!tarball_var:?docker/stellar-cli.pin must set $tarball_var}"
  local expected_binary="${!binary_var:?docker/stellar-cli.pin must set $binary_var}"

  # Keyed on the binary digest, so a re-cut release under the same tag still misses the cache.
  cache_dir="$cache_root/$expected_binary"
  cli_bin="$cache_dir/stellar"
  if [[ -x "$cli_bin" ]]; then
    actual="$(shasum -a 256 "$cli_bin" | awk '{print $1}')"
    if [[ "$actual" == "$expected_binary" ]]; then
      printf '%s\n' "$cli_bin"
      return
    fi
    echo "scvs_pinned_stellar_cli: cached binary does not match the pin — refetching" >&2
    echo "    expected $expected_binary ($binary_var)" >&2
    echo "    actual   $actual" >&2
    rm -f "$cli_bin"
  fi

  asset_version="${STELLAR_CLI_VERSION#v}"
  asset_name="${STELLAR_CLI_ASSET_TEMPLATE/\{version\}/$asset_version}"
  asset_name="${asset_name/\{triple\}/$triple}"
  asset_url="https://github.com/stellar/stellar-cli/releases/download/${STELLAR_CLI_VERSION}/${asset_name}"

  mkdir -p "$cache_dir"
  stage="$(mktemp -d "$cache_root/.fetch-XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$stage'" RETURN

  echo "scvs_pinned_stellar_cli: fetching ${STELLAR_CLI_VERSION} for ${triple}" >&2
  curl --fail --location --silent --show-error --retry 3 --retry-connrefused \
    --output "$stage/$asset_name" "$asset_url"

  actual="$(shasum -a 256 "$stage/$asset_name" | awk '{print $1}')"
  if [[ "$actual" != "$expected_tarball" ]]; then
    echo "scvs_pinned_stellar_cli: TARBALL DIGEST MISMATCH — refusing to unpack" >&2
    echo "    url      $asset_url" >&2
    echo "    expected $expected_tarball ($tarball_var)" >&2
    echo "    actual   $actual" >&2
    return 1
  fi

  tar -xzf "$stage/$asset_name" -C "$stage" stellar
  actual="$(shasum -a 256 "$stage/stellar" | awk '{print $1}')"
  if [[ "$actual" != "$expected_binary" ]]; then
    echo "scvs_pinned_stellar_cli: BINARY DIGEST MISMATCH — refusing to hand this binary on" >&2
    echo "    expected $expected_binary ($binary_var)" >&2
    echo "    actual   $actual" >&2
    return 1
  fi

  install -m 0755 "$stage/stellar" "$cli_bin"
  printf '%s\n' "$cli_bin"
}
