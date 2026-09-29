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

COPY --from=build /app .

# One of: verification-svc | orchestrator-svc | query-svc
ENV SERVICE_ENTRYPOINT=verification-svc

USER node
RUN cd packages/db \
    && POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_DB=x POSTGRES_USER=x POSTGRES_PASSWORD=x \
       ./node_modules/.bin/prisma --version >/dev/null
CMD ["sh", "-c", "node services/${SERVICE_ENTRYPOINT}/dist/main.js"]
