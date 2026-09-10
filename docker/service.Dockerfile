# Generic resident-service image, shared by services/verification-svc, services/orchestrator-svc and
# services/query-svc.

FROM node:26-slim AS build
WORKDIR /app

# The whole workspace, deliberately — not an enumerated list of the manifests these three services depend on.
COPY . .

RUN corepack enable \
    && pnpm install --frozen-lockfile

# @scvs/db's build (`prisma generate && tsc`) reads these at prisma.config.ts's top level to assemble
# DATABASE_URL (see packages/db/src/env.ts).
ENV POSTGRES_HOST=localhost \
    POSTGRES_PORT=5433 \
    POSTGRES_DB=scvs \
    POSTGRES_USER=scvs \
    POSTGRES_PASSWORD=scvs_local_dev

# Only the three resident services and their dependency closure.
RUN pnpm --filter @scvs/verification-svc... \
         --filter @scvs/orchestrator-svc... \
         --filter @scvs/query-svc... run build

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app

# libssl3/libdbus-1-3/libudev1/libstdc++6 are the `stellar` binary's runtime NEEDED libraries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 libdbus-1-3 libudev1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# verification-svc's preflight and orchestrator-svc's chain reader both `spawn` this to read the deployed Wasm
# hash and SEP-58 metadata (STELLAR_CLI_PATH, default `stellar`).
ARG TARGETARCH
COPY docker/prebuilt/bin/${TARGETARCH}/stellar /usr/local/bin/stellar
RUN chmod +x /usr/local/bin/stellar

# Copied wholesale, dev dependencies included.
COPY --from=build /app .

# One of: verification-svc | orchestrator-svc | query-svc
ENV SERVICE_ENTRYPOINT=verification-svc

USER node
CMD ["sh", "-c", "node services/${SERVICE_ENTRYPOINT}/dist/main.js"]
