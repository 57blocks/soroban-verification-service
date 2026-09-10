#!/usr/bin/env bash

# Prints an executable released Stellar CLI for the fixture scripts to read Wasm metadata with.
#
# The fixture scripts need exactly one host-side CLI capability: reading `contractmetav0` back out of
# a built Wasm. Everything else happens inside the recorded build image — the SEP-58 recipe is written
# there with `--meta`, and source archives come from this repository's own deterministic tar writer.
# So the requirement here is the weakest one that does the job, `contract info meta`, and any released
# CLI satisfies it. Nothing is compiled, nothing is cached, no commit is pinned: a host that already
# has `stellar` on PATH needs no setup at all.
scvs_released_stellar_cli() {
  local candidate
  local -a candidates=()

  if [[ -n "${SCVS_FIXTURE_STELLAR_BIN:-}" ]]; then
    printf '%s\n' "$SCVS_FIXTURE_STELLAR_BIN"
    return
  fi

  candidate="$(command -v stellar || true)"
  [[ -n "$candidate" ]] && candidates+=("$candidate")

  # Homebrew may put an older CLI ahead of a newer cargo-installed one, so both are tried and the
  # first that answers the capability probe wins — PATH order does not decide.
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
