#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="${SCVS_FIXTURE_OUTPUT_ROOT:-$repo_root/artifacts/e2e-fixtures}"
wasm_root="$output_root/wasm/purpose-built"
manifest="$output_root/purpose-built-wasm.ndjson"
source_sha="ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533"
source_uri="https://raw.githubusercontent.com/jia57b/soroban-contract/main/$source_sha.tar.gz"
# The official image every fixture below is built with, unless a caller overrides it. Digest-pinned:
# registry.yaml records this digest as cliver 27.0.0 / rsver 1.96.0.
image="${SCVS_FIXTURE_BUILD_IMAGE:-docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43}"

sep58_bldopt=(--locked --manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize)
sep58_recipe_meta=()

# ── Fixtures on pairs no official image exists for ────────────────────────────────────────────────
# Every fixture built by `docker_build` above is built inside an *official* image, which is what makes
# F-LEG-1 meaningful: built by the official toolchain, verified by our composed one, so a `verified`
# verdict is cross-environment evidence rather than a determinism check.
#
# These are deliberately the other thing. Docker Hub publishes six `(cliver, rsver)` pairs (corpus scan
# §7) against 99 live ones, and the corpus's top three demand pairs are not among them — those contracts
# can only ever be verified through composition. So each of these is built inside **our own composed
# image**, which is the only environment that can produce its pair at all.
#
# ★ What that costs, stated rather than glossed: built by our composer and verified by our composer, a
# byte match proves the pipeline works and the composition is deterministic — it does **not** prove our
# composed environment matches what some third party's build of the same pair would produce, because
# there is no official build of that pair to be right or wrong against. F-LEG-1 carries that half;
# `compose_targets` below records which pairs carry this narrower determinism evidence.
#
# ── The table, and why it is a table rather than two environment variables ────────────────────────
# It started as `SCVS_FIXTURE_COMPOSE_ONLY_CLIVER` / `_RSVER`, which made adding a pair free — and that
# was the problem. A fixture's pair is the one thing about it that has to be *reviewable*: it decides
# what the E2E case proves, it has to agree with `registry.yaml`, and "why this pair" is an argument, not
# a parameter. An ad-hoc pair passed on the command line produces a deployed contract nobody can trace
# to a reason. So the pairs live here, one line each, and `SCVS_FIXTURE_COMPOSE_TARGET` selects one.
#
# One target per run, because each needs a *different* composed image and the image is a separate input.
#
# ── ★ Why the build options are in the table too ──────────────────────────────────────────────────
# They were hard-coded in `compose_build`, all four of them, copied from F-LEG-1. That broke on the first
# 25.1.0 build: `error: unexpected argument '--locked' found`. `stellar contract build` gained `--locked`
# somewhere between 25.1.0 and 25.2.0, so the option set is a property of the **cliver**, not of the
# fixture family.
#
# And the fix is not "drop --locked everywhere" — it is the same shape as the 1.81.0 finding. A recipe is
# a *submitter claim replayed inside the recorded toolchain*, so a fixture whose recipe carries an option
# its own cliver does not accept describes a build that could not have happened. No real 25.1.0 contract
# on chain records `--locked`, because no 25.1.0 binary would have accepted it. Carrying it would make the
# fixture test a recipe that cannot exist.
#
# What is lost by dropping it, stated: `--locked` turns "cargo silently updated Cargo.lock" into an error.
# Without it, determinism rests on the committed `Cargo.lock` being sufficient — which it is for a fixed
# source tree, since cargo only re-resolves when the manifest forces it. That is exactly the position
# every real 25.1.0 contract is in, so the fixture is not weaker than what it stands for.
#
# The options therefore live here, per row, reviewed like the pair — and `assertImageAcceptsOptions`
# below refuses to build when the image does not offer one of them, naming it, instead of letting a
# 20-minute run die on the first `docker run`.
#
#   id | cliver | rsver | output wasm | build options (space-separated)
compose_targets=(
  # Rank 2 by demand (10.1%). The first fixture of this kind; deployed 2026-08-19.
  "F-COMPOSE-ONLY|25.2.0#28484880988199233a7e8e87c97cb12dac323cb3|1.94.0|f-compose-only.wasm|--locked --manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize"
  # ★ Rank 1 by demand: 813 live contracts, 25.2% of live class-B on its own — the single largest
  # combination in the corpus, and one no official image serves. Composition proved it can be built
  # (`eng-tools/composition-pairs.mjs`'s `demand-01` row); this carries it end to end.
  # ★ No `--locked`: 25.1.0's `contract build` does not have it (measured 2026-08-19 —
  # "unexpected argument '--locked' found"). See the note above; this is correctness, not a compromise.
  "F-DEMAND-01|25.1.0#a048a57a75762458b487052e0021ea704a926bee|1.95.0|f-demand-01.wasm|--manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize"
  # The old end. Rank 4 (4.6%), the oldest CLI major with real demand, and the only fixture below
  # rust 1.94. The corpus's risk is concentrated here — 23.x CLIs with 1.8x/1.9x Rust — and the E2E
  # layer had nothing below 27.0.0/1.94.0. `oldest-major-cli23.3.0-rust1.91.1` composed, so the
  # environment exists; what is untested is whether a *submission* on it reaches a verdict.
  # ★ 23.3.0 is older still, so it certainly lacks `--locked`. `--optimize` and `--package` are
  # measured present: the option probe accepted them and the build succeeded on 2026-08-19. That run
  # also answered the MSRV worry — soroban-sdk 25.3.1 accepts rust 1.91.1 — and, more usefully,
  # resolved that same SDK *without* `--locked`, which is the observation the "a committed Cargo.lock
  # is sufficient" claim above was missing.
  "F-OLD-END|23.3.0#08473ac20016c369067ce0dbca91d9595e72d6d4|1.91.1|f-old-end.wasm|--manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize"
)
compose_target="${SCVS_FIXTURE_COMPOSE_TARGET:-F-COMPOSE-ONLY}"
compose_cliver=""
compose_rsver=""
compose_output=""
compose_bldopt=()
for compose_row in "${compose_targets[@]}"; do
  IFS='|' read -r row_id row_cliver row_rsver row_output row_bldopt <<<"$compose_row"
  if [[ "$row_id" == "$compose_target" ]]; then
    compose_cliver="$row_cliver"
    compose_rsver="$row_rsver"
    compose_output="$row_output"
    # No option contains a space, so word-splitting is the whole parse. `read -ra` rather than an
    # unquoted expansion so nothing is glob-expanded on the way in.
    read -ra compose_bldopt <<<"$row_bldopt"
  fi
done
tag_only_image="docker.io/stellar/stellar-cli:25.2.0"
untrusted_image="docker.io/library/rust@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950"
work_root="$(mktemp -d /tmp/scvs-e2e-purpose.XXXXXX)"
# CI runs the outer verifiable CLI as the recorded build-image user so its hardened archive remains
# readable to the inner Docker build. Let that user traverse this disposable root. Local runs retain
# their original permissions and do not enter this branch.
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  chmod a+rwx "$work_root"
fi
source_root="$work_root/source"
canonical_source_root="$work_root/canonical-source/source"
docker_cargo="/tmp/scvs-e2e-official-cargo"
fixture_cargo_home="${SCVS_FIXTURE_CARGO_HOME:-/tmp/scvs-fixture-cargo}"
upgrade_fixture_root="$repo_root/test/fixtures/e2e/contracts/upgrade-fixture"
multi_package_fixture_root="$repo_root/test/fixtures/sample-contracts/multi-package-workspace"
multi_package_build_root="$work_root/multi-package-source"
multi_package_archive="$output_root/archives/multi-package-source.tar.gz"
private_cli58_archive="$output_root/archives/private-cli58-canary.tar.gz"
private_cli58_source_uri="https://example.invalid/scvs/private-cli58-canary.tar.gz"
zip_cli58_archive="$repo_root/artifacts/e2e-fixtures/archives/f58-source-tree.zip"
zip_cli58_source_uri="https://example.invalid/scvs/f58-source-tree.zip"
public_zip_cli58_archive="$repo_root/artifacts/e2e-fixtures/archives/f58-public-source-tree.zip"
public_zip_cli58_source_uri="https://example.invalid/scvs/f58-public-source-tree.zip"
build_scope="${SCVS_FIXTURE_BUILD_SCOPE:-all}"
build_variant="${SCVS_FIXTURE_BUILD_VARIANT:-}"
stellar_bin=""
tar_bin="${SCVS_FIXTURE_TAR_BIN:-tar}"

cleanup() {
  case "$work_root" in
    /tmp/scvs-e2e-purpose.*)
      # Docker owns some target files under the official image UID in CI. The GitHub runner has
      # passwordless sudo; local runs retain the ordinary unprivileged cleanup path.
      if [[ "${GITHUB_ACTIONS:-}" == "true" ]] && command -v sudo >/dev/null; then
        sudo rm -rf "$work_root"
      else
        rm -rf "$work_root"
      fi
      ;;
    *) echo "refusing to remove unexpected work directory: $work_root" >&2 ;;
  esac
}
trap cleanup EXIT

for command in cargo curl docker git jq od perl shasum; do
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

assert_archive_format() {
  local archive="$1"
  local format="$2"
  local magic
  [[ -f "$archive" ]] || { echo "archive is missing: $archive" >&2; exit 1; }
  magic="$(od -An -tx1 -N4 "$archive" | tr -d '[:space:]')"
  case "$format" in
    tar.gz)
      [[ "$magic" == 1f8b* ]] || {
        echo "expected gzip-compressed tar archive: $archive (magic $magic)" >&2
        exit 1
      }
      ;;
    zip)
      [[ "$magic" == 504b0304* || "$magic" == 504b0506* || "$magic" == 504b0708* ]] || {
        echo "expected ZIP archive: $archive (magic $magic)" >&2
        exit 1
      }
      ;;
    *)
      echo "unsupported archive format assertion: $format" >&2
      exit 1
      ;;
  esac
}

if [[ "$build_scope" != "all" && "$build_scope" != "upgrade" && "$build_scope" != "mismatch" && "$build_scope" != "image-policy" && "$build_scope" != "multi-package" && "$build_scope" != "compose-only" && "$build_scope" != "ci" && "$build_scope" != "zip" ]]; then
  echo "SCVS_FIXTURE_BUILD_SCOPE must be all, upgrade, mismatch, image-policy, multi-package, compose-only, ci, or zip" >&2
  exit 1
fi

# Both checks here rather than at the build call, so a wrong target or a wrong image costs a second
# instead of a clone, a pull and a compile.
if [[ "$build_scope" == "compose-only" ]]; then
  # An unknown target would otherwise reach `compose_build` with empty pair variables, and
  # `assert_metadata_value` would compare the real cliver against "" — a confusing way to say "typo".
  if [[ -z "$compose_output" ]]; then
    echo "unknown SCVS_FIXTURE_COMPOSE_TARGET '$compose_target'. Known targets:" >&2
    for compose_row in "${compose_targets[@]}"; do
      IFS='|' read -r row_id row_cliver row_rsver _ <<<"$compose_row"
      echo "  $row_id  ($row_cliver / $row_rsver)" >&2
    done
    echo "Adding a pair means adding a row to the table in this file and to registry.yaml — the pair" >&2
    echo "is the fixture's whole argument, so it is reviewed, not passed on the command line." >&2
    exit 1
  fi

  # The whole point of these fixtures is a pair no official image exists for; run one against the
  # official default and it produces F-LEG-1's bytes under a name that claims otherwise.
  # `compose_build`'s metadata and duplicate-hash guards would catch it, but the honest form of the
  # constraint is stated up front, with the command that satisfies it.
  if [[ "$image" == docker.io/stellar/stellar-cli* ]]; then
    echo "scope 'compose-only' needs a composed image in SCVS_FIXTURE_BUILD_IMAGE, not the official one" >&2
    echo "build one for $compose_target first:" >&2
    echo "  node eng-tools/check-composition-template.mjs --cliver '$compose_cliver' \\" >&2
    echo "    --rsver '$compose_rsver' --keep-image --no-contract-build" >&2
    echo "then re-run with SCVS_FIXTURE_BUILD_IMAGE=scvs-composed:template-gate-v3" >&2
    exit 1
  fi

  echo "compose target: $compose_target  ($compose_cliver / $compose_rsver) → $compose_output"
fi

# The host CLI only reads emitted metadata. Builds and recipe metadata generation happen in the
# recorded image, so this path needs no unmerged CLI capability.
stellar_candidates=()
if [[ -n "${SCVS_FIXTURE_STELLAR_BIN:-}" ]]; then
  stellar_candidates+=("$SCVS_FIXTURE_STELLAR_BIN")
else
  default_stellar="$(command -v stellar || true)"
  [[ -n "$default_stellar" ]] && stellar_candidates+=("$default_stellar")

  cargo_stellar="${CARGO_HOME:-${HOME:?}/.cargo}/bin/stellar"
  if [[ -x "$cargo_stellar" && "$cargo_stellar" != "$default_stellar" ]]; then
    stellar_candidates+=("$cargo_stellar")
  fi
fi

for candidate in "${stellar_candidates[@]}"; do
  [[ -x "$candidate" ]] || continue
  "$candidate" contract info meta --help >/dev/null 2>&1 || continue
  stellar_bin="$candidate"
  break
done

if [[ -z "$stellar_bin" ]]; then
  echo "no released Stellar CLI with 'contract info meta' found" >&2
  echo "install one (e.g. 'cargo install --locked stellar-cli') or set SCVS_FIXTURE_STELLAR_BIN" >&2
  exit 1
fi

echo "using Stellar CLI: $stellar_bin ($("$stellar_bin" --version | head -n 1))"

mkdir -p "$wasm_root" "$docker_cargo"
# This bind-mounted Cargo cache is shared by every fixture image in the run, and those images do not
# agree on a UID: the official stellar-cli image runs as an unprivileged user, the untrusted `rust`
# image runs as root. Whoever built first owns the crate files it downloaded, and the host runner owns
# neither — so a plain `chmod -R` here fails with EPERM on every second and later build scope of the
# same job. Relax the tree as root on the CI runner, which has passwordless sudo; local runs keep the
# unprivileged chmod they always used, and only downgrade its failure to a warning, since the crates a
# build image already owns are writable by that image regardless. The cache holds downloaded crates
# only and, unlike $work_root, is deliberately reused across runs.
if [[ "${GITHUB_ACTIONS:-}" == "true" ]] && command -v sudo >/dev/null 2>&1; then
  sudo chmod -R a+rwX "$docker_cargo"
elif ! chmod -R a+rwX "$docker_cargo"; then
  echo "warning: cannot relax permissions on $docker_cargo (crates owned by a build image UID)" >&2
  echo "         remove it with 'sudo rm -rf $docker_cargo' if the fixture build cannot write crates" >&2
fi
if [[ "$build_scope" != "all" && -f "$manifest" ]]; then
  if [[ "$build_scope" == "upgrade" ]]; then
    jq_filter='select(.fixture_id | startswith("F-UPG-") | not)'
  elif [[ "$build_scope" == "ci" ]]; then
    jq_filter='select(.fixture_id != "F-LEG-1-testnet" and .fixture_id != "F-LEG-3-target" and .fixture_id != "F-58-PRIV-testnet" and .fixture_id != "F-58-ZIP-testnet" and .fixture_id != "F-58-ZIP-PUBLIC-testnet")'
  elif [[ "$build_scope" == "zip" ]]; then
    jq_filter='select(.fixture_id != "F-58-ZIP-testnet" and .fixture_id != "F-58-ZIP-PUBLIC-testnet")'
  elif [[ "$build_scope" == "image-policy" ]]; then
    jq_filter='select(.fixture_id != "F-BADIMG-TAG" and .fixture_id != "F-BADIMG-UNTRUSTED")'
  elif [[ "$build_scope" == "multi-package" ]]; then
    jq_filter='select(.fixture_id != "F-MULTIPKG-testnet")'
  elif [[ "$build_scope" == "compose-only" ]]; then
    # Only the row being rebuilt is dropped. Each compose target is a separate run against a separate
    # image, so a run for one must not evict the manifest entries the others already produced.
    jq_filter="$(printf 'select(.fixture_id != "%s-testnet")' "$compose_target")"
  else
    jq_filter='select(.fixture_id != "F-LEG-3-target")'
  fi
  jq -c "$jq_filter" "$manifest" > "$work_root/purpose-built-wasm.ndjson"
  cp "$work_root/purpose-built-wasm.ndjson" "$manifest"
else
  : > "$manifest"
fi

# The archive named by source_uri/source_sha256 is the actual build input. Do not substitute a Git
# checkout that might no longer match the archive bytes the fixture declares.
if [[ "$build_scope" != "multi-package" ]]; then
  canonical_archive="${SCVS_E2E_CANONICAL_SOURCE_ARCHIVE:-$repo_root/artifacts/e2e-fixtures/archives/canonical-source.tar.gz}"
  if [[ "$canonical_archive" != /* ]]; then canonical_archive="$repo_root/$canonical_archive"; fi
  if [[ ! -f "$canonical_archive" ]]; then
    canonical_archive="$work_root/canonical-source.tar.gz"
    curl -L --fail --silent --show-error --connect-timeout 15 --max-time 120 --retry 3 --retry-all-errors -o "$canonical_archive" "$source_uri"
  fi
  actual_source_sha="$(shasum -a 256 "$canonical_archive" | awk '{print $1}')"
  if [[ "$actual_source_sha" != "$source_sha" ]]; then
    echo "canonical source archive hash mismatch: expected $source_sha, got $actual_source_sha" >&2
    exit 1
  fi
  assert_archive_format "$canonical_archive" tar.gz
  mkdir -p "$(dirname "$canonical_source_root")"
  "$tar_bin" -xzf "$canonical_archive" -C "$(dirname "$canonical_source_root")"
  [[ -d "$canonical_source_root" ]] || { echo "canonical archive has no source/ root" >&2; exit 1; }
fi

reset_source_root() {
  # Docker builds run as the image's unprivileged UID in CI, so their target files are not removable
  # by the GitHub runner. Use the same scoped sudo cleanup as the EXIT trap before copying the next
  # fixture source tree; local runs retain the ordinary unprivileged path.
  case "$source_root" in
    "$work_root"/*)
      if [[ "${GITHUB_ACTIONS:-}" == "true" ]] && command -v sudo >/dev/null 2>&1; then
        sudo rm -rf "$source_root"
      else
        rm -rf "$source_root"
      fi
      ;;
    *) echo "refusing to remove unexpected source directory: $source_root" >&2; exit 1 ;;
  esac
  cp -R "$canonical_source_root" "$source_root"
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then chmod a+rwx "$source_root"; chmod -R a+rX "$source_root"; fi
}

if [[ "$build_scope" != "multi-package" ]]; then reset_source_root; fi

# A composed image is built locally by `check-composition-template.mjs` and exists in no registry, so
# an unconditional `docker pull` would fail on exactly the scope this parameterisation exists for.
# Pull only what is not already here; a missing *remote* image still fails, loudly, on the pull.
if docker image inspect "$image" >/dev/null 2>&1; then
  echo "using local image: $image"
else
  echo "pulling fixture build image: $image"
  docker pull "$image"
fi

record_wasm() {
  local fixture_id="$1"
  local wasm_path="$2"
  local source_archive="${3:-}"
  local wasm_hash
  local bytes
  local metadata
  local source_archive_path=""
  local source_sha256=""
  [[ -s "$wasm_path" ]] || { echo "Wasm output is empty or missing: $wasm_path" >&2; exit 1; }
  wasm_hash="$(shasum -a 256 "$wasm_path" | awk '{print $1}')"
  [[ "$wasm_hash" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid Wasm SHA-256 for $wasm_path: $wasm_hash" >&2; exit 1; }
  bytes="$(wc -c < "$wasm_path" | tr -d ' ')"
  metadata="$("$stellar_bin" contract info meta --wasm "$wasm_path" --output json)"
  if [[ -n "$source_archive" ]]; then
    source_archive_path="${source_archive#"$repo_root/"}"
    source_sha256="$(shasum -a 256 "$source_archive" | awk '{print $1}')"
  fi
  jq -nc \
    --arg fixture_id "$fixture_id" \
    --arg path "${wasm_path#"$repo_root/"}" \
    --arg wasm_hash "$wasm_hash" \
    --argjson bytes "$bytes" \
    --argjson metadata "$metadata" \
    --arg source_archive "$source_archive_path" \
    --arg source_sha256 "$source_sha256" \
    '{fixture_id:$fixture_id,path:$path,wasm_hash:$wasm_hash,bytes:$bytes,metadata:$metadata}
      + if $source_archive == "" then {} else {source_archive:$source_archive,source_sha256:$source_sha256} end' \
    >> "$manifest"
}

docker_build_wasm() {
  local fixture_id="$1"
  local output_name="$2"
  shift 2
  local meta_value
  local -a build_options=(contract build "${sep58_bldopt[@]}")
  for meta_value in "$@"; do
    build_options+=(--meta "$meta_value")
  done
  echo "building fixture: $fixture_id"
  docker run --rm \
    -v "$docker_cargo:/stellar/.cargo" \
    -v "$source_root:/source" \
    -w /source \
    "$image" "${build_options[@]}" >/dev/null
  cp "$source_root/target/wasm32v1-none/release/verified_demo.wasm" "$wasm_root/$output_name"
}

docker_build() {
  local fixture_id="$1"
  local output_name="$2"
  shift 2
  docker_build_wasm "$fixture_id" "$output_name" "$@"
  record_wasm "$fixture_id" "$wasm_root/$output_name"
}

assert_metadata_value() {
  local wasm_path="$1"
  local key="$2"
  local expected="$3"
  local actual
  actual="$(
    "$stellar_bin" contract info meta --wasm "$wasm_path" --output json \
      | jq -r --arg key "$key" '[.[] | .sc_meta_v0 | select(.key == $key) | .val] | if length == 1 then .[0] else empty end'
  )"
  if [[ "$actual" != "$expected" ]]; then
    echo "metadata mismatch for $wasm_path: $key expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_metadata_list() {
  local wasm_path="$1" key="$2"
  shift 2
  local actual expected
  actual="$("$stellar_bin" contract info meta --wasm "$wasm_path" --output json | jq -c --arg key "$key" '[.[] | .sc_meta_v0 | select(.key == $key) | .val]')"
  expected="$(jq -nc '$ARGS.positional' --args -- "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "metadata list mismatch for $wasm_path: $key" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

assert_metadata_keys() {
  local wasm_path="$1"
  shift
  local actual expected
  actual="$(
    "$stellar_bin" contract info meta --wasm "$wasm_path" --output json \
      | jq -c '[.[] | .sc_meta_v0?.key? | select(. == "bldimg" or . == "source_uri" or . == "source_sha256" or . == "bldopt")]'
  )"
  expected="$(jq -nc '$ARGS.positional' --args -- "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "SEP-58 metadata key sequence mismatch for $wasm_path" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

# Builds the selected compose target inside whatever `$image` is, then *proves* which toolchain did it.
#
# ── Why the metadata assertions are the point, not a formality ────────────────────────────────────
# These fixtures' whole claim is "the deployed bytes were produced by a pair no official image exists
# for". Nothing in `docker run` enforces that: point `SCVS_FIXTURE_BUILD_IMAGE` at the wrong tag — the
# official 27.0.0 default, a stale composed image from an earlier gate run, the image for a *different*
# row of the table above — and this function still emits a perfectly good Wasm, `deploy-testnet.sh`
# still deploys it, and the E2E case still goes green while testing a pair already covered. The failure
# mode is a fixture that passes for the wrong reason, which is the one the SEC cases taught us to
# design out.
#
# ★ That last variant is new and is the reason this check matters more now than when there was one
# target. With three rows and one shared image tag (`scvs-composed:template-gate-v3` — the gate reuses
# the tag for every pair), forgetting to re-run `check-composition-template.mjs` between targets
# silently builds the next fixture in the previous fixture's image. The metadata read-back is the only
# thing standing between that mistake and a deployed contract that lies about its own toolchain.
#
# So the built Wasm's own `contractmetav0` — the same bytes the chain will carry and the same field
# the verifier reads to decide it must compose — is read back and required to name the row's pair. The
# image does not get to be trusted about itself.
# Asks the image which build options it offers, and refuses the ones it does not.
#
# ── Why this is a separate step and not just "let the build fail" ──────────────────────────────────
# It did just let the build fail, once, and the failure was fine — `error: unexpected argument
# '--locked' found`, clear and immediate. What was not fine is that it arrived **after** an 8-minute
# composition, a git clone and a docker pull, and it names one option at a time: fix `--locked` and the
# next run tells you about `--optimize`. An option set is small and `--help` is instant, so the whole
# answer is worth having before anything is spent.
#
# ★ Matched against the flag name only, so `--manifest-path=x` is checked as `--manifest-path`. Matching
# the whole `key=value` would silently pass every option through, since no help text contains a value.
assert_image_accepts_options() {
  local help_text option flag
  local -a unsupported=()

  if ! help_text="$(docker run --rm --entrypoint stellar "$image" contract build --help 2>&1)"; then
    echo "could not read \`contract build --help\` from $image" >&2
    echo "$help_text" >&2
    exit 1
  fi

  for option in "${compose_bldopt[@]}"; do
    flag="${option%%=*}"
    # Word-boundary-ish: the flag must appear followed by a space, `=`, `<`, or end of line, so
    # `--package` is not satisfied by `--package-name` appearing somewhere in the help.
    if ! printf '%s' "$help_text" | grep -qE -- "(^|[^A-Za-z0-9._-])${flag}([ =<]|$)"; then
      unsupported+=("$option")
    fi
  done

  if [[ ${#unsupported[@]} -gt 0 ]]; then
    echo "$compose_target's build options are not all offered by $image" >&2
    echo "  cliver in this image : $compose_cliver" >&2
    echo "  unsupported          : ${unsupported[*]}" >&2
    echo "" >&2
    echo "A recipe is a submitter claim replayed inside the recorded toolchain, so an option this cliver" >&2
    echo "does not accept describes a build that could not have happened — no real contract on this pair" >&2
    echo "records it either. Remove it from this fixture's row in compose_targets (and from its" >&2
    echo "registry.yaml bldopt), rather than from every row." >&2
    echo "" >&2
    echo "What the image does offer:" >&2
    printf '%s\n' "$help_text" | grep -E '^\s+-' >&2 || true
    exit 1
  fi

  echo "build options accepted by this image: ${compose_bldopt[*]}"
}

compose_build() {
  local output_name="$compose_output"
  assert_image_accepts_options
  docker run --rm \
    -v "$source_root:/source" \
    -w /source \
    "$image" \
      contract build \
      "${compose_bldopt[@]}" >/dev/null
  cp "$source_root/target/wasm32v1-none/release/verified_demo.wasm" "$wasm_root/$output_name"

  assert_metadata_value "$wasm_root/$output_name" "cliver" "$compose_cliver"
  assert_metadata_value "$wasm_root/$output_name" "rsver" "$compose_rsver"

  # Every fixture here is the same source, so two of them agreeing byte for byte means the toolchain did
  # not actually change and one is a duplicate of the other wearing a different name. The metadata check
  # above would still pass in that case only if the image were also wrong in a matching way — but the
  # cheap and common mistake is a *stale* image, where metadata and bytes are consistently the previous
  # row's. Compared against F-LEG-1 and against every sibling in the table.
  local mine
  mine="$(shasum -a 256 "$wasm_root/$output_name" | awk '{print $1}')"
  local other other_hash other_name
  for other in "f-leg-1-official.wasm" "${compose_targets[@]}"; do
    case "$other" in
      *"|"*) other_name="${other##*|}" ;;
      *) other_name="$other" ;;
    esac
    [[ "$other_name" == "$output_name" ]] && continue
    [[ -f "$wasm_root/$other_name" ]] || continue
    other_hash="$(shasum -a 256 "$wasm_root/$other_name" | awk '{print $1}')"
    if [[ "$mine" == "$other_hash" ]]; then
      echo "$compose_target produced $other_name's exact bytes ($mine)." >&2
      echo "\$image is not a different toolchain — re-run check-composition-template.mjs for" >&2
      echo "  --cliver '$compose_cliver' --rsver '$compose_rsver'" >&2
      echo "before building this target; the gate reuses one tag for every pair." >&2
      exit 1
    fi
  done

  # No source archive: the source tree is byte-identical to F-LEG-1's, which is what makes the pair the
  # only variable. The inventory entries therefore reuse F-LEG-1's `source_uri`/`source_sha256`.
  record_wasm "$compose_target-testnet" "$wasm_root/$output_name"
}

build_sep58_recipe_meta() {
  local recipe_bldimg="$1" recipe_source_uri="${2:-$source_uri}" recipe_source_sha="${3:-$source_sha}" option
  sep58_recipe_meta=("bldimg=$recipe_bldimg" "source_uri=$recipe_source_uri" "source_sha256=$recipe_source_sha")
  for option in "${sep58_bldopt[@]}"; do sep58_recipe_meta+=("bldopt=$option"); done
}

assert_digest_pinned_image() {
  local fixture_id="$1"
  [[ "$image" == *"@sha256:"* ]] || { echo "$fixture_id requires a digest-pinned SCVS_FIXTURE_BUILD_IMAGE" >&2; exit 1; }
}

sep58_build() {
  local fixture_id="$1"
  local output_name="$2"
  local meta_value="${3:-}"
  local recipe_source_sha="${4:-$source_sha}"
  local recipe_source_uri="${5:-$source_uri}"
  local source_archive="${6:-}"
  local -a recipe_bldopt=("${sep58_bldopt[@]}")
  assert_digest_pinned_image "$fixture_id"
  if [[ -n "$meta_value" ]]; then
    # `build --verifiable --meta source_repo=...` wrote the custom metadata before the SEP-58 recipe
    # and recorded that option between --package and --optimize. Preserve those bytes while using only
    # released `contract build --meta` capabilities.
    [[ "$meta_value" == "source_repo=github:example/contract" ]] || {
      echo "$fixture_id has no recorded build --meta compatibility mapping for: $meta_value" >&2
      exit 1
    }
    recipe_bldopt=(
      "${sep58_bldopt[0]}"
      "${sep58_bldopt[1]}"
      "${sep58_bldopt[2]}"
      "--meta=source_repo='github:example/contract'"
      "${sep58_bldopt[3]}"
    )
  fi
  sep58_recipe_meta=()
  [[ -n "$meta_value" ]] && sep58_recipe_meta+=("$meta_value")
  sep58_recipe_meta+=("bldimg=$image" "source_uri=$recipe_source_uri" "source_sha256=$recipe_source_sha")
  for option in "${recipe_bldopt[@]}"; do sep58_recipe_meta+=("bldopt=$option"); done
  docker_build_wasm "$fixture_id" "$output_name" "${sep58_recipe_meta[@]}"
  assert_metadata_value "$wasm_root/$output_name" "bldimg" "$image"
  assert_metadata_value "$wasm_root/$output_name" "source_sha256" "$recipe_source_sha"
  assert_metadata_value "$wasm_root/$output_name" "source_uri" "$recipe_source_uri"
  assert_metadata_list "$wasm_root/$output_name" "bldopt" "${recipe_bldopt[@]}"
  sep58_metadata_keys=(bldimg source_uri source_sha256)
  for option in "${recipe_bldopt[@]}"; do sep58_metadata_keys+=(bldopt); done
  assert_metadata_keys "$wasm_root/$output_name" "${sep58_metadata_keys[@]}"
  if [[ -n "$source_archive" ]]; then
    case "$source_archive" in
      *.zip) assert_archive_format "$source_archive" zip ;;
      *.tar.gz) assert_archive_format "$source_archive" tar.gz ;;
      *) echo "unsupported source archive suffix for $fixture_id: $source_archive" >&2; exit 1 ;;
    esac
  fi
  record_wasm "$fixture_id" "$wasm_root/$output_name" "$source_archive"
}

zip_metadata_build() {
  local fixture_id="$1"
  local output_name="$2"
  local source_archive="$3"
  local recipe_source_uri="$4"
  local recipe_source_sha
  if [[ ! -f "$source_archive" ]]; then
    echo "$fixture_id source archive is missing: $source_archive" >&2
    exit 1
  fi
  recipe_source_sha="$(shasum -a 256 "$source_archive" | awk '{print $1}')"
  sep58_build "$fixture_id" "$output_name" "" "$recipe_source_sha" "$recipe_source_uri" "$source_archive"
}

prepare_private_cli58_source() {
  local scope="${SCVS_FIXTURE_DEPLOYMENT_SCOPE:-local}"
  local scope_digest
  local archive_tree="$work_root/private-cli58-archive"

  reset_source_root
  scope_digest="$(printf '%s' "$scope" | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
  printf 'SCVS-CLI58-PRIVATE-CANARY-%s\n' "$scope_digest" > "$source_root/fixture-canary.txt"

  mkdir -p "$archive_tree/source" "$(dirname "$private_cli58_archive")"
  cp -R "$source_root/." "$archive_tree/source/"
  (
    cd "$archive_tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
      | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$private_cli58_archive"
  )
}

# Same run-scoped identity pattern as F-58-PRIV. The ZIP fixtures' source hashes are inputs to the
# rebuild key, so a fresh contract address alone would only recompute a verdict against an old rebuild.
prepare_zip_cli58_source() {
  local label="$1"
  local scope="${SCVS_FIXTURE_DEPLOYMENT_SCOPE:-local}"
  local scope_digest

  scope_digest="$(printf '%s' "$scope" | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
  reset_source_root
  printf 'SCVS-%s-CANARY-%s\n' "$label" "$scope_digest" > "$source_root/fixture-zip-canary.txt"
}

prepare_multi_package_source() {
  local archive_tree="$work_root/multi-package-archive"

  mkdir -p "$multi_package_build_root" "$archive_tree/source" "$(dirname "$multi_package_archive")"
  cp -R "$multi_package_fixture_root/." "$multi_package_build_root/"
  rm -rf "$multi_package_build_root/target"
  rm -f "$multi_package_build_root/README.md" "$multi_package_build_root/.DS_Store"
  # See the source-root permission above: `stellar contract build` creates its temporary target
  # directory at the root of this bind mount.
  chmod a+rwx "$multi_package_build_root"
  cp -R "$multi_package_build_root/." "$archive_tree/source/"
  (
    cd "$archive_tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
          | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion \
          "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$multi_package_archive"
  )
}

multi_package_build() {
  prepare_multi_package_source
  docker run --rm \
    -v "$docker_cargo:/stellar/.cargo" \
    -v "$multi_package_build_root:/source" \
    -w /source \
    "$image" \
      contract build \
      --manifest-path=contracts/contract-b/Cargo.toml >/dev/null
  cp "$multi_package_build_root/target/wasm32v1-none/release/contract_b.wasm" \
    "$wasm_root/f-multipkg-contract-b.wasm"
  record_wasm \
    "F-MULTIPKG-testnet" \
    "$wasm_root/f-multipkg-contract-b.wasm" \
    "$multi_package_archive"
}

if [[ "$build_scope" == "all" || "$build_scope" == "ci" ]]; then
  docker_build "F-LEG-1-testnet" "f-leg-1-official.wasm"
fi

if [[ "$build_scope" == "all" || "$build_scope" == "mismatch" || "$build_scope" == "ci" ]]; then
  target_source="$source_root/contracts/verified-demo/src/lib.rs"
  target_label="Fixture target"
  if [[ -n "$build_variant" ]]; then
    variant_digest="$(printf '%s' "$build_variant" | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
    target_label="$target_label $variant_digest"
  fi
  if ! grep -q '"Hello"' "$target_source"; then
    echo "F-LEG-3 target source no longer contains the expected canonical greeting" >&2
    exit 1
  fi
  REPLACEMENT="$target_label" perl -0pi -e 's/"Hello"/"$ENV{REPLACEMENT}"/' "$target_source"
  docker_build "F-LEG-3-target" "f-leg-3-target.wasm"
  reset_source_root
fi

if [[ "$build_scope" == "all" ]]; then
  docker_build "F-S55-A" "f-s55-a.wasm" "source_repo=github:example/contract"
  docker_build "F-S55-B" "f-s55-b.wasm" "source_repo=https://example.com/src.tar.gz"
  docker_build "F-S55-C" "f-s55-c.wasm" "source_repo=https://mirror.example.com/github:foo"
  sep58_build "F-58-testnet" "f-58-complete.wasm"
  sep58_build "F-S55-D" "f-s55-d.wasm" "source_repo=github:example/contract"
fi

if [[ "$build_scope" == "ci" ]]; then
  # Exercise RA5's literal prefix rule against chain-read metadata, rather than a submitter-controlled body.
  docker_build "F-S55-E-testnet" "f-s55-e.wasm" "source_repo=GitHub:example/contract"
  docker_build "F-S55-F-testnet" "f-s55-f.wasm" "source_repo=github:"

  prepare_private_cli58_source
  private_cli58_source_sha="$(shasum -a 256 "$private_cli58_archive" | awk '{print $1}')"
  sep58_build \
    "F-58-PRIV-testnet" \
    "f-58-private.wasm" \
    "" \
    "$private_cli58_source_sha" \
    "$private_cli58_source_uri" \
    "$private_cli58_archive"

fi

if [[ "$build_scope" == "ci" || "$build_scope" == "zip" ]]; then
  prepare_zip_cli58_source "F58-ZIP"
  zip_metadata_build \
    "F-58-ZIP-testnet" \
    "f-58-zip-source.wasm" \
    "$zip_cli58_archive" \
    "$zip_cli58_source_uri"

  prepare_zip_cli58_source "F58-ZIP-PUBLIC"
  zip_metadata_build \
    "F-58-ZIP-PUBLIC-testnet" \
    "f-58-public-zip-source.wasm" \
    "$public_zip_cli58_archive" \
    "$public_zip_cli58_source_uri"
fi

if [[ "$build_scope" == "all" || "$build_scope" == "image-policy" ]]; then
  build_sep58_recipe_meta "$tag_only_image"
  docker_build "F-BADIMG-TAG" "f-badimg-tag.wasm" "${sep58_recipe_meta[@]}"
  assert_metadata_value "$wasm_root/f-badimg-tag.wasm" "bldimg" "$tag_only_image"

  build_sep58_recipe_meta "$untrusted_image"
  docker_build "F-BADIMG-UNTRUSTED" "f-badimg-untrusted.wasm" "${sep58_recipe_meta[@]}"
  assert_metadata_value "$wasm_root/f-badimg-untrusted.wasm" "bldimg" "$untrusted_image"
fi

if [[ "$build_scope" == "all" || "$build_scope" == "multi-package" ]]; then
  multi_package_build
fi

# Deliberately **not** in `all`. `all` runs against the official default image, and building this
# fixture there would produce exactly F-LEG-1's bytes under a name that claims otherwise — the
# duplicate-hash guard inside `compose_only_build` would stop it, but the honest expression of the
# constraint is that this scope needs an image `all` does not have.
if [[ "$build_scope" == "compose-only" ]]; then
  compose_build
fi

build_upgrade_version() {
  local version="$1"
  local output_name="f-upg-v$version.wasm"
  local archive_root="$output_root/archives/upgrade"
  local source_archive="$archive_root/f-upg-v$version-source.tar.gz"
  local archive_tree="$work_root/upgrade-v$version-archive"

  reset_source_root
  mkdir -p "$archive_root" "$archive_tree/source"
  cp -R "$source_root/." "$archive_tree/source/"
  cp "$upgrade_fixture_root/v$version.rs" \
    "$archive_tree/source/contracts/verified-demo/src/lib.rs"
  (
    cd "$archive_tree"
    find source -exec touch -t 202001010000 {} +
    LC_ALL=C find source -print | LC_ALL=C sort \
      | COPYFILE_DISABLE=1 "$tar_bin" --format ustar --no-recursion \
          "${tar_owner_args[@]}" -cf - -T - \
      | gzip -n > "$source_archive"
  )
  cp "$upgrade_fixture_root/v$version.rs" \
    "$source_root/contracts/verified-demo/src/lib.rs"
  docker run --rm \
    -v "$docker_cargo:/stellar/.cargo" \
    -v "$source_root:/source" \
    -w /source \
    "$image" \
      contract build \
      --locked \
      --manifest-path=contracts/verified-demo/Cargo.toml \
      --package=verified-demo \
      --optimize >/dev/null
  cp "$source_root/target/wasm32v1-none/release/verified_demo.wasm" \
    "$wasm_root/$output_name"
  record_wasm "F-UPG-v$version" "$wasm_root/$output_name" "$source_archive"
}

if [[ "$build_scope" == "all" || "$build_scope" == "upgrade" ]]; then
  build_upgrade_version 1
  build_upgrade_version 2
  reset_source_root
fi

if [[ "$build_scope" == "all" ]]; then
  reset_source_root
  cp -R "$source_root" "$work_root/plain-source"
  (
    cd "$work_root/plain-source"
    env \
      CARGO_HOME="$fixture_cargo_home" \
      SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 \
      cargo rustc \
        --locked \
        --manifest-path=contracts/verified-demo/Cargo.toml \
        --package=verified-demo \
        --target=wasm32v1-none \
        --release \
        --crate-type=cdylib >/dev/null
  )
  cp "$work_root/plain-source/target/wasm32v1-none/release/verified_demo.wasm" \
    "$wasm_root/f-none.wasm"
  record_wasm "F-NONE-testnet" "$wasm_root/f-none.wasm"
fi

echo "built $(wc -l < "$manifest" | tr -d ' ') purpose-built Wasm fixtures"
