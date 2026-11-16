FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY services/builder/package.json ./services/builder/package.json

RUN corepack enable \
    && pnpm config set fetch-timeout 300000 \
    && pnpm config set fetch-retries 5 \
    && pnpm config set network-concurrency 4 \
    && pnpm config set minimum-release-age 0 \
    && pnpm install --frozen-lockfile --ignore-scripts --filter @scvs/builder...

COPY packages/core ./packages/core
COPY services/builder ./services/builder

RUN pnpm --filter @scvs/builder... run build

FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime-deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY services/builder/package.json ./services/builder/package.json

RUN corepack enable \
    && pnpm config set fetch-timeout 300000 \
    && pnpm config set fetch-retries 5 \
    && pnpm config set network-concurrency 4 \
    && pnpm config set minimum-release-age 0 \
    && pnpm install --prod --frozen-lockfile --ignore-scripts --filter @scvs/builder...

# Debian's docker.io is the 20.10 CLI, which rejects `bind-recursive=disabled`; the hosts run Docker 25.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS docker-cli
ARG TARGETARCH
ARG DOCKER_CLI_VERSION=29.9.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) arch=aarch64; sha256=873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73 ;; \
      amd64) arch=x86_64; sha256=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb ;; \
      *) echo "no docker CLI is pinned for ${TARGETARCH:-an unset TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    echo "${sha256}  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker

FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# `libarchive-tools` supplies the `bsdtar` archive-extraction.ts uses to read zip source archives.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates libssl3 libdbus-1-3 libudev1 libstdc++6 gosu awscli libarchive-tools \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

COPY docker/builder-entrypoint.sh /usr/local/bin/builder-entrypoint.sh
RUN chmod +x /usr/local/bin/builder-entrypoint.sh

WORKDIR /app
# reference-alignment.ts reads the pin at runtime.
COPY docker/stellar-cli.pin ./docker/stellar-cli.pin

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=runtime-deps /app/services/builder/node_modules ./services/builder/node_modules

COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/services/builder/package.json ./services/builder/package.json
COPY --from=build /app/services/builder/dist ./services/builder/dist

ENTRYPOINT ["/usr/local/bin/builder-entrypoint.sh"]
