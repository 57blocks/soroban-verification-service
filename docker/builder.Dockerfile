# ---------------------------------------------------------------------------------------------
# Stage 1/3: compile TypeScript with the full (dev-included) dependency graph.
# ---------------------------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------------------------
# Stage 2/3: a second, `--prod`-only install of the exact same manifests.
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

# ---------------------------------------------------------------------------------------------
# Stage 3/3: the actual runtime image — only what's needed to execute the built JS + drive the
# `stellar`/`docker` CLIs as subprocesses.
FROM node:24-slim

# `libarchive-tools` supplies `bsdtar`, and it is here for exactly one caller: `archive-extraction.ts` reads
# **zip** source archives with it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io git ca-certificates libssl3 libdbus-1-3 libudev1 libstdc++6 gosu awscli libarchive-tools \
    && rm -rf /var/lib/apt/lists/*

# Nothing in this container executes it any more: retiring the verify mechanism left `stellarCli()` without a
# caller, and the two chain readers that do spawn the CLI are resident services built from
# `docker/service.Dockerfile`, not this Batch job.
COPY docker/builder-entrypoint.sh /usr/local/bin/builder-entrypoint.sh
RUN chmod +x /usr/local/bin/builder-entrypoint.sh

WORKDIR /app
# The pin **stays**, and it is not the binary's leftover: `reference-alignment.ts` reads this file at runtime to
# report which upstream release the rebuild was aligned to, in the published diagnostics.
COPY docker/stellar-cli.pin ./docker/stellar-cli.pin

# node_modules first (rarely change, and the same content whether or not app code changed) so an
# application-only source edit doesn't bust the layer these come from.
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=runtime-deps /app/services/builder/node_modules ./services/builder/node_modules

COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/services/builder/package.json ./services/builder/package.json
COPY --from=build /app/services/builder/dist ./services/builder/dist

# No default CMD: each container in the Batch job definition provides its own `command`, which maps to this
# ENTRYPOINT's `"$@"`.
ENTRYPOINT ["/usr/local/bin/builder-entrypoint.sh"]
