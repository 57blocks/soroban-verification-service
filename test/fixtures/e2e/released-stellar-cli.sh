#!/usr/bin/env bash

scvs_released_stellar_cli() {
  local candidate
  local -a candidates=()

  if [[ -n "${SCVS_FIXTURE_STELLAR_BIN:-}" ]]; then
    printf '%s\n' "$SCVS_FIXTURE_STELLAR_BIN"
    return
  fi

  candidate="$(command -v stellar || true)"
  [[ -n "$candidate" ]] && candidates+=("$candidate")

  # Homebrew may shadow a newer cargo-installed CLI on PATH, so every candidate is probed.
  local cargo_stellar="${CARGO_HOME:-${HOME:?}/.cargo}/bin/stellar"
  if [[ -x "$cargo_stellar" && "$cargo_stellar" != "$candidate" ]]; then
    candidates+=("$cargo_stellar")
  fi

  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    "$candidate" contract info meta --help >/dev/null 2>&1 || continue
    printf '%s\n' "$candidate"
    return
  done

  echo "no released Stellar CLI with 'contract info meta' found" >&2
  echo "install one (e.g. 'cargo install --locked stellar-cli') or set SCVS_FIXTURE_STELLAR_BIN" >&2
  return 1
}
