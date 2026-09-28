ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG RSVER
ARG CLIVER
ARG RUST_PROFILE=minimal
ARG RUST_TARGETS=wasm32v1-none

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    DEBIAN_FRONTEND=noninteractive

COPY rustup-init /tmp/rustup-init
COPY stellar /usr/local/bin/stellar

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

# Overrides any rust-toolchain file in the submitted source.
ENV RUSTUP_TOOLCHAIN=${RSVER}

ENV STELLAR_NO_UPDATE_CHECK=1
RUN useradd --uid 1000 --create-home --shell /bin/bash scvs \
 && mkdir -p /source \
 && chown scvs:scvs /source

LABEL org.stellar.scvs.cliver="${CLIVER}" \
      org.stellar.scvs.rsver="${RSVER}" \
      org.stellar.scvs.template-version="v2" \
      org.stellar.scvs.composed-by="scvs-composer"

USER scvs
WORKDIR /source
