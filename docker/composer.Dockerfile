FROM node:24-slim AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY services/composer/package.json ./services/composer/package.json

RUN corepack enable \
    && pnpm config set fetch-timeout 300000 \
    && pnpm config set fetch-retries 5 \
    && pnpm config set network-concurrency 4 \
    && pnpm config set minimum-release-age 0 \
    && pnpm install --frozen-lockfile --ignore-scripts --filter @scvs/composer...

COPY packages/core ./packages/core
COPY packages/config ./packages/config
COPY services/composer ./services/composer

RUN pnpm --filter @scvs/composer... run build

FROM node:24-slim AS runtime-deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY services/composer/package.json ./services/composer/package.json

RUN corepack enable \
    && pnpm config set fetch-timeout 300000 \
    && pnpm config set fetch-retries 5 \
    && pnpm config set network-concurrency 4 \
    && pnpm config set minimum-release-age 0 \
    && pnpm install --prod --frozen-lockfile --ignore-scripts --filter @scvs/composer...

FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io awscli tar ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Baked in, never fetched: these are the reviewed pins `template_version` names.
COPY docker/composed-environments ./docker/composed-environments

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=runtime-deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=runtime-deps /app/services/composer/node_modules ./services/composer/node_modules

COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/config/package.json ./packages/config/package.json
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/services/composer/package.json ./services/composer/package.json
COPY --from=build /app/services/composer/dist ./services/composer/dist

ENTRYPOINT ["node", "services/composer/dist/entrypoint.js"]
