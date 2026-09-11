# v2 = v1 plus the one runtime library the pinned base image does not supply. v1 is kept beside this directory
# unchanged and unused: every composition it attempted failed `smoke_test_failed` because the released `stellar`
# binary hard-links `libdbus-1.so.3`, so it never published a recipe.

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

# All three already checksum-verified by the composer before this build started.
COPY rustup-init /tmp/rustup-init
COPY stellar /usr/local/bin/stellar

# The released `stellar` binary's DT_NEEDED set is
# libc/libm/libgcc_s/libstdc++.so.6/libssl.so.3/libcrypto.so.3/libdbus-1.so.3/libudev.so.1.
COPY libdbus-1-3.deb /tmp/libdbus-1-3.deb

RUN chmod +x /tmp/rustup-init /usr/local/bin/stellar \
 && dpkg -i /tmp/libdbus-1-3.deb \
 && rm -f /tmp/libdbus-1-3.deb \
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
      org.stellar.scvs.template-version="v2" \
      org.stellar.scvs.composed-by="scvs-composer"

USER scvs
WORKDIR /source
