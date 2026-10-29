# syntax=docker/dockerfile:1

# Node 26 (Active LTS) on Debian 13 "trixie" slim, pinned by digest so every
# build uses exactly the same base. Dependabot (docker ecosystem) bumps it.
ARG NODE_IMAGE=node:26.13.0-trixie-slim@sha256:__NODE_DIGEST__

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
# Installs all deps; the postinstall hook generates the Prisma client into src/generated.
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY src ./src
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------- migrate
# One-off job (see docker-compose.yml): applies migrations, then exits.
# Separate from the runtime image so the Prisma CLI never ships to production.
FROM build AS migrate
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------- prod-deps
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: skip `prisma generate` (the CLI is a dev dependency; the
# generated client is already compiled into dist/).
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
# Files are owned by root and read-only to the app user; the app runs as the
# image's unprivileged "node" user (uid 1000).
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
