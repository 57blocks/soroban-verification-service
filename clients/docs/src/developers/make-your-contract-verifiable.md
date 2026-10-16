# Make your contract verifiable

The easiest contract to verify is one whose deployed Wasm records its own build recipe. Then anyone can
verify it with nothing but the source, and the result is the strongest kind:
`recipe_source: on_chain_metadata` with `image_trust_level: official_trusted`.

The recipe has to be in the Wasm before you deploy it; a deployed Wasm never gains metadata later. This
page shows how to build a Wasm that carries one. [Supported contracts](../introduction/supported-contracts.md)
explains the classes this puts your contract in.

## What the recipe is

[SEP-58](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0058.md) entries in the
Wasm's `contractmetav0` section, next to the `cliver` entry the Stellar CLI writes:

| Entry | Records | Times |
| --- | --- | --- |
| `bldimg` | The build image, pinned by digest | Once |
| `bldopt` | One build option | Once per option, in order |
| `bldarg` | One argument in place of `contract build` | Only if you used other arguments |
| `source_sha256` | The SHA-256 of the source archive you built from | Once |
| `source_uri` | Where that archive can be downloaded | Once, optional |

The verifier rebuilds with exactly these values. It reads them only from the metadata section that holds
`cliver`, so write them with the same `stellar contract build` that writes `cliver`, as below.

## 1. Make the build reproducible

The verifier builds with no network, so everything the build needs has to come from the archive or
from its lockfile:

- **Commit `Cargo.lock`.** The verifier downloads your dependencies with `cargo vendor --locked` before
  the build, so the lockfile has to resolve as it stands.
- **Fetch dependencies from public hosts.** crates.io and the common Git hosts (GitHub, GitLab,
  Bitbucket, Codeberg) are allowed by default; a verifier can allow others.
- **Leave out `[source]` replacements** in `.cargo/config.toml`; a build that overrides crate sources is
  refused.
- **Do not download anything from `build.rs`.** The build runs offline.
- **Expect the image's Rust toolchain to be used.** A `rust-toolchain.toml` in the source does not change
  it.

## 2. Make the source archive first

Archive the source before you build, so the archive holds no build output, and hash it. The hash goes
into the recipe, so this archive is the one you will submit, byte for byte:

```sh
git archive --format=tar.gz --prefix=my-contract/ -o my-contract.tar.gz HEAD
SOURCE_SHA256=$(sha256sum my-contract.tar.gz | cut -d' ' -f1)
```

[Prepare your source](./prepare-your-source.md) covers what the archive may contain. If you will publish
the archive at a stable URL, decide the URL now; you can record it too.

## 3. Pick the build image

Use the official Stellar CLI image, named by digest:

```sh
docker pull docker.io/stellar/stellar-cli:25.2.0
IMAGE=docker.io/$(docker inspect --format '{{index .RepoDigests 0}}' docker.io/stellar/stellar-cli:25.2.0)
echo "$IMAGE"   # docker.io/stellar/stellar-cli@sha256:…
```

This verifier accepts a recorded image only in exactly this form, with the `docker.io/` host written
out; Docker leaves it off the digest it reports, hence the prefix above. An image named by a tag is
refused, because a tag can point at different bytes later, and an image from another repository is not
accepted.

## 4. Build from the archive, recording the recipe

Unpack the archive and build inside it, with the image, passing each part of the recipe as `--meta`:

```sh
mkdir build && tar -xzf my-contract.tar.gz -C build --strip-components=1 && cd build

docker run --rm -v "$PWD:/source" -w /source --entrypoint stellar "$IMAGE" contract build \
  --manifest-path=contracts/my-contract/Cargo.toml --package=my-contract --optimize \
  --meta "bldimg=$IMAGE" \
  --meta "source_sha256=$SOURCE_SHA256" \
  --meta "source_uri=https://example.com/my-contract.tar.gz" \
  --meta "bldopt=--manifest-path=contracts/my-contract/Cargo.toml" \
  --meta "bldopt=--package=my-contract" \
  --meta "bldopt=--optimize"
```

Record every option you pass to `contract build`, one `bldopt` each, as `--flag=value` in a single word:

- Paths are relative to the archive's root and stay inside it.
- Short flags such as `-p`, and values separated by a space, cannot be replayed.
- Leave out `--out-dir`; the verifier replaces it with its own. Avoid `--target-dir`, `--offline`,
  `--config` and `--env`: they change the build environment rather than the build, and the console
  refuses them, so such a contract could be submitted only through the API.

Drop the `source_uri` line if the archive will not stay at a fixed address; the source can be given at
submission instead.

## 5. Check the Wasm before you deploy

```sh
stellar contract info meta --wasm target/wasm32v1-none/release/my_contract.wasm   # the path the build printed
```

The output lists `cliver` and each entry you recorded. Deploy this Wasm. Then check the deployed
contract in the [console](./use-the-console.md): preflight should say it can be verified, and fill in
everything but the source.

Every upgrade deploys a new Wasm. Build each one this way, or the new Wasm will not carry a recipe.

## If the contract is already deployed without a recipe

A contract built with the Stellar CLI still records the CLI and Rust versions it was built with, and a
verifier can compose an environment from those; you supply the source and build options. A rebuild in a
composed environment is published with `image_trust_level: upstream_pinned`, and it is more likely to
mismatch, because the original build may have depended on something it never recorded.
[Supported contracts](../introduction/supported-contracts.md#cli-legacy) lists the toolchains a verifier
cannot compose.
