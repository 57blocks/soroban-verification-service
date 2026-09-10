# Same three-stage shape as `docker/builder.Dockerfile` — and the same reasoning behind each stage, which that
# file documents at length; read it first.

# ---------------------------------------------------------------------------------------------
# Stage 1/3: compile TypeScript with the full (dev-included) dependency graph.
# ---------------------------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------------------------
# Stage 2/3: a `--prod`-only install of the same manifests, so the final image carries no
# typescript/jest/tsx/@types.
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

# ---------------------------------------------------------------------------------------------
# Stage 3/3: the runtime image.
FROM node:24-slim

# `docker.io` for the build/push — `awscli` for the ECR authorization token.
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io awscli tar ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The composition templates. Baked in, never fetched: these are the reviewed, verifier-owned pins that
# `template_version` refers to, and `recipe_sha256` hashes over them.
COPY docker/composed-environments ./docker/composed-environments

# node_modules first (rarely change, same content whether or not app code changed) so an application-only source
# edit does not bust the layer these come from.
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
