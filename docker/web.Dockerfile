FROM node:24-slim AS build
WORKDIR /app

COPY . .

RUN corepack enable \
    && pnpm install --frozen-lockfile

# @scvs/db's build reads these in prisma.config.ts to assemble DATABASE_URL.
ENV POSTGRES_HOST=localhost \
    POSTGRES_PORT=5433 \
    POSTGRES_DB=scvs \
    POSTGRES_USER=scvs \
    POSTGRES_PASSWORD=scvs_local_dev

# "" means same origin.
ARG VITE_VERIFY_API_URL=""
ENV VITE_VERIFY_API_URL=${VITE_VERIFY_API_URL}

ARG SCVS_BUILD_COMMIT=""
ARG SCVS_BUILD_DATE=""
ENV SCVS_BUILD_COMMIT=${SCVS_BUILD_COMMIT} \
    SCVS_BUILD_DATE=${SCVS_BUILD_DATE}

# Through turbo, not `pnpm --filter`: only turbo's task graph runs the OpenAPI generation first.
RUN pnpm run generate:api-client \
    && pnpm exec turbo run build --filter=soroban-verify-web --filter=soroban-verify-docs

# turbo strips variables turbo.json does not declare, and a stripped stamp silently renders "dev".
RUN stamp=$(sed -n 's/.*<meta name="build" content="\([^"]*\)".*/\1/p' clients/web/dist/index.html); \
    echo "console build stamp: ${stamp:-<absent>}"; \
    if [ -n "$SCVS_BUILD_COMMIT" ] \
      && [ "$stamp" != "${SCVS_BUILD_DATE}.$(echo "$SCVS_BUILD_COMMIT" | cut -c1-7)" ]; then \
      echo "web.Dockerfile: the build stamp did not reach the bundle, got '${stamp:-absent}'" >&2; \
      exit 1; \
    fi

FROM nginx:1.30-alpine
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/clients/web/dist /usr/share/nginx/html
COPY --from=build /app/clients/docs/dist /usr/share/nginx/html/docs

COPY docker/web-entrypoint.sh /docker-entrypoint.d/40-scvs-runtime-config.sh
# Both leave the document root: a restart re-renders the template; spa-routes.conf must not be served.
RUN mkdir -p /etc/nginx/scvs \
    && mv /usr/share/nginx/html/index.html /etc/nginx/scvs/index.html.template \
    && mv /usr/share/nginx/html/spa-routes.conf /etc/nginx/scvs/spa-routes.conf \
    && chmod +x /docker-entrypoint.d/40-scvs-runtime-config.sh

EXPOSE 80
