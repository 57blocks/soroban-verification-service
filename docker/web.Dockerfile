# The submission/results console (clients/web): a Vite build served by nginx.

FROM node:24-slim AS build
WORKDIR /app

# Whole workspace: the console's build chain reaches further than its own directory. It imports the
# generated API client, which orval generates from verification-svc's OpenAPI document, which is
# produced by booting the real Nest app — so building the console builds verification-svc too. That
# chain is declared in turbo.json; the point here is that an enumerated COPY list would be wrong.
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

# "" means same origin (src/lib/http.ts).
ARG VITE_VERIFY_API_URL=""
ENV VITE_VERIFY_API_URL=${VITE_VERIFY_API_URL}

# The build stamp behind `<meta name="build">`. Baked in here rather than substituted at container start
# like the feature flag below: the image IS the build, so a stamp it carries can never name a different one.
# `.dockerignore` excludes `.git`, so the build cannot derive these; unset renders "dev".
ARG SCVS_BUILD_COMMIT=""
ARG SCVS_BUILD_DATE=""
ENV SCVS_BUILD_COMMIT=${SCVS_BUILD_COMMIT} \
    SCVS_BUILD_DATE=${SCVS_BUILD_DATE}

# Through Turborepo, not raw pnpm filters: the OpenAPI-generation step is an edge in turbo.json's task graph
# (`generate` dependsOn `@scvs/verification-svc#generate:openapi`), and a plain `pnpm --filter ... run generate`
# does not know about it.
RUN pnpm run generate:api-client \
    && pnpm exec turbo run build --filter=soroban-verify-web

# The stamp reaches Vite through turbo, which strips every variable `turbo.json` does not declare — and the
# "dev" a stripped variable falls back to is indistinguishable from a legitimate local build, which is how
# the first version of this shipped unstamped. Asserted rather than trusted.
RUN stamp=$(sed -n 's/.*<meta name="build" content="\([^"]*\)".*/\1/p' clients/web/dist/index.html); \
    echo "console build stamp: ${stamp:-<absent>}"; \
    if [ -n "$SCVS_BUILD_COMMIT" ] \
      && [ "$stamp" != "${SCVS_BUILD_DATE}.$(echo "$SCVS_BUILD_COMMIT" | cut -c1-7)" ]; then \
      echo "web.Dockerfile: the build stamp did not reach the bundle, got '${stamp:-absent}'" >&2; \
      exit 1; \
    fi

FROM nginx:1.27-alpine
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/clients/web/dist /usr/share/nginx/html

# Feature flags are substituted at container start, not baked in here.
COPY docker/web-entrypoint.sh /docker-entrypoint.d/40-scvs-runtime-config.sh
# Both moves out of the document root are load-bearing: the template so a restart substitutes into
# placeholders again, and the route allowlist so an nginx config is not served as a static file. `mv` fails the
# build when the bundle carries neither, which is what a broken generator looks like.
RUN mkdir -p /etc/nginx/scvs \
    && mv /usr/share/nginx/html/index.html /etc/nginx/scvs/index.html.template \
    && mv /usr/share/nginx/html/spa-routes.conf /etc/nginx/scvs/spa-routes.conf \
    && chmod +x /docker-entrypoint.d/40-scvs-runtime-config.sh

EXPOSE 80
