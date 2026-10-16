FROM node:24-slim AS build
WORKDIR /app

# Prisma picks its schema engine by the libssl it detects here, so it must match the runtime stage's.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY . .

RUN corepack enable \
    && pnpm install --frozen-lockfile

# @scvs/db's build reads these in prisma.config.ts to assemble DATABASE_URL.
ENV POSTGRES_HOST=localhost \
    POSTGRES_PORT=5433 \
    POSTGRES_DB=scvs \
    POSTGRES_USER=scvs \
    POSTGRES_PASSWORD=scvs_local_dev

RUN pnpm --filter @scvs/verification-svc... \
         --filter @scvs/orchestrator-svc... \
         --filter @scvs/query-svc... run build

FROM node:24-slim AS runtime-deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/aws/package.json ./packages/aws/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db-query/package.json ./packages/db-query/package.json
COPY packages/http/package.json ./packages/http/package.json
COPY packages/openapi/package.json ./packages/openapi/package.json
COPY packages/storage-layout/package.json ./packages/storage-layout/package.json
COPY clients/sdk/package.json ./clients/sdk/package.json
COPY services/verification-svc/package.json ./services/verification-svc/package.json
COPY services/orchestrator-svc/package.json ./services/orchestrator-svc/package.json
COPY services/query-svc/package.json ./services/query-svc/package.json

RUN corepack enable \
    && pnpm config set fetch-timeout 300000 \
    && pnpm config set fetch-retries 5 \
    && pnpm config set network-concurrency 4 \
    && pnpm config set minimum-release-age 0 \
    && pnpm install --prod --frozen-lockfile --ignore-scripts \
         --filter soroban-verification-service... \
         --filter @scvs/verification-svc... \
         --filter @scvs/orchestrator-svc... \
         --filter @scvs/query-svc...

# pnpm never runs @prisma/engines' postinstall, so the CLI fetches its schema engine on first use; do it here, as root.
RUN cd packages/db && ./node_modules/.bin/prisma --version >/dev/null

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

# libssl3/libdbus-1-3/libudev1/libstdc++6 are the `stellar` binary's runtime NEEDED libraries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 libdbus-1-3 libudev1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY docker/prebuilt/bin/${TARGETARCH}/stellar /usr/local/bin/stellar
RUN chmod +x /usr/local/bin/stellar

COPY --from=runtime-deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/aws/node_modules ./packages/aws/node_modules
COPY --from=runtime-deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=runtime-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=runtime-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=runtime-deps /app/packages/db-query/node_modules ./packages/db-query/node_modules
COPY --from=runtime-deps /app/packages/http/node_modules ./packages/http/node_modules
COPY --from=runtime-deps /app/packages/openapi/node_modules ./packages/openapi/node_modules
COPY --from=runtime-deps /app/packages/storage-layout/node_modules ./packages/storage-layout/node_modules
COPY --from=runtime-deps /app/clients/sdk/node_modules ./clients/sdk/node_modules
COPY --from=runtime-deps /app/services/verification-svc/node_modules ./services/verification-svc/node_modules
COPY --from=runtime-deps /app/services/orchestrator-svc/node_modules ./services/orchestrator-svc/node_modules
COPY --from=runtime-deps /app/services/query-svc/node_modules ./services/query-svc/node_modules

COPY --from=build /app/packages/aws/package.json ./packages/aws/package.json
COPY --from=build /app/packages/aws/dist ./packages/aws/dist
COPY --from=build /app/packages/config/package.json ./packages/config/package.json
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/http/package.json ./packages/http/package.json
COPY --from=build /app/packages/http/dist ./packages/http/dist
COPY --from=build /app/packages/openapi/package.json ./packages/openapi/package.json
COPY --from=build /app/packages/openapi/dist ./packages/openapi/dist
COPY --from=build /app/packages/storage-layout/package.json ./packages/storage-layout/package.json
COPY --from=build /app/packages/storage-layout/dist ./packages/storage-layout/dist
COPY --from=build /app/clients/sdk/package.json ./clients/sdk/package.json
COPY --from=build /app/clients/sdk/dist ./clients/sdk/dist
COPY --from=build /app/services/verification-svc/package.json ./services/verification-svc/package.json
COPY --from=build /app/services/verification-svc/dist ./services/verification-svc/dist
COPY --from=build /app/services/orchestrator-svc/package.json ./services/orchestrator-svc/package.json
COPY --from=build /app/services/orchestrator-svc/dist ./services/orchestrator-svc/dist
COPY --from=build /app/services/query-svc/package.json ./services/query-svc/package.json
COPY --from=build /app/services/query-svc/dist ./services/query-svc/dist

# db-migrate runs `prisma migrate` from these two packages and `tsx scripts/seed-tvl.ts` from /app.
COPY --from=build /app/packages/db/package.json /app/packages/db/prisma.config.ts ./packages/db/
COPY --from=build /app/packages/db/src/env.ts ./packages/db/src/env.ts
COPY --from=build /app/packages/db/prisma ./packages/db/prisma
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db-query/package.json /app/packages/db-query/prisma.config.ts ./packages/db-query/
COPY --from=build /app/packages/db-query/prisma ./packages/db-query/prisma
COPY --from=build /app/packages/db-query/dist ./packages/db-query/dist
COPY --from=build /app/scripts/seed-tvl.ts ./scripts/seed-tvl.ts
COPY --from=build /app/config/legal-documents.example.json ./config/legal-documents.example.json

# One of: verification-svc | orchestrator-svc | query-svc
ENV SERVICE_ENTRYPOINT=verification-svc

USER node
RUN cd packages/db \
    && POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_DB=x POSTGRES_USER=x POSTGRES_PASSWORD=x \
       ./node_modules/.bin/prisma --version >/dev/null
CMD ["sh", "-c", "node services/${SERVICE_ENTRYPOINT}/dist/main.js"]
