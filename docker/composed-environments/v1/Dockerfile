# Builds the environment a cli-legacy contract's recorded (cliver, rsver) names, from official components the
# composer has ALREADY downloaded and checksum-verified.

# Digest-pinned, supplied from template.json's `base_image`.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Chain-derived, per composition.
ARG RSVER
ARG CLIVER
# Verifier-owned, from template.json.
ARG RUST_PROFILE=minimal
ARG RUST_TARGETS=wasm32v1-none

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    DEBIAN_FRONTEND=noninteractive

# The digest-pinned buildpack-deps base already contains gcc, libc development headers, ca-certificates, and
# useradd.

# Both already checksum-verified by the composer before this build started.
COPY rustup-init /tmp/rustup-init
COPY stellar /usr/local/bin/stellar

RUN chmod +x /tmp/rustup-init /usr/local/bin/stellar \
 && /tmp/rustup-init -y \
      --no-modify-path \
      --profile "${RUST_PROFILE}" \
      --default-toolchain "${RSVER}" \
      --target "${RUST_TARGETS}" \
 && rm -f /tmp/rustup-init \
 && chmod -R a+w "${RUSTUP_HOME}" "${CARGO_HOME}"

# Without this, a composed environment would reintroduce exactly the failure this whole feature exists to
# eliminate — submitted input deciding the build environment — by a different door.
ENV RUSTUP_TOOLCHAIN=${RSVER}

ENV STELLAR_NO_UPDATE_CHECK=1
RUN useradd --uid 1000 --create-home --shell /bin/bash scvs \
 && mkdir -p /source \
 && chown scvs:scvs /source

# Recorded on the image so `docker inspect` alone answers "what is this and which recipe produced it".
LABEL org.stellar.scvs.cliver="${CLIVER}" \
      org.stellar.scvs.rsver="${RSVER}" \
      org.stellar.scvs.template-version="v1" \
      org.stellar.scvs.composed-by="scvs-composer"

USER scvs
WORKDIR /source
