#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="${SCVS_FIXTURE_OUTPUT_ROOT:-$repo_root/artifacts/e2e-fixtures}"
wasm_root="$output_root/wasm/purpose-built"
manifest="$output_root/purpose-built-wasm.ndjson"
source_sha="ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533"
source_uri="https://raw.githubusercontent.com/jia57b/soroban-contract/main/$source_sha.tar.gz"
image="${SCVS_FIXTURE_BUILD_IMAGE:-docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43}"

sep58_bldopt=(--locked --manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize)
sep58_recipe_meta=()

#   id | cliver | rsver | output wasm | build options (space-separated)
compose_targets=(
  "F-COMPOSE-ONLY|25.2.0#28484880988199233a7e8e87c97cb12dac323cb3|1.94.0|f-compose-only.wasm|--locked --manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize"
  "F-DEMAND-01|25.1.0#a048a57a75762458b487052e0021ea704a926bee|1.95.0|f-demand-01.wasm|--manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize"
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
    read -ra compose_bldopt <<<"$row_bldopt"
  fi
done
tag_only_image="docker.io/stellar/stellar-cli:25.2.0"
untrusted_image="docker.io/library/rust@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950"
work_root="$(mktemp -d /tmp/scvs-e2e-purpose.XXXXXX)"
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

if [[ "$build_scope" == "compose-only" ]]; then
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
# Images with different UIDs share this Cargo cache, so relax it (as root on CI) before each build.
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
    jq_filter="$(printf 'select(.fixture_id != "%s-testnet")' "$compose_target")"
  else
    jq_filter='select(.fixture_id != "F-LEG-3-target")'
  fi
  jq -c "$jq_filter" "$manifest" > "$work_root/purpose-built-wasm.ndjson"
  cp "$work_root/purpose-built-wasm.ndjson" "$manifest"
else
  : > "$manifest"
fi

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

# Composed images exist only locally, so pull only an image that is not already present.
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
# The flag must be followed by space, `=`, `<` or EOL, so `--package` does not match `--package-name`.
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
