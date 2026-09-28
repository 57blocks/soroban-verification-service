FROM node:24-slim AS build
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

FROM node:24-slim AS runtime-deps
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

FROM node:24-slim

# `libarchive-tools` supplies the `bsdtar` archive-extraction.ts uses to read zip source archives.
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io git ca-certificates libssl3 libdbus-1-3 libudev1 libstdc++6 gosu awscli libarchive-tools \
    && rm -rf /var/lib/apt/lists/*

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
