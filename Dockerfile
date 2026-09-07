# syntax=docker/dockerfile:1

# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
# node:22-slim (Debian/glibc), not -alpine: better-sqlite3 has no prebuilt
# binaries and always compiles from source via node-gyp (needs python3 +
# a C++ toolchain), AND the .node addon it produces must be ABI-compatible
# with the runner stage below — which is also glibc-based. Building on
# alpine (musl) would both lack python3/build tools out of the box and
# produce a binary that likely can't even load in the glibc runner.
FROM node:22-slim AS builder

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

# ─── Stage 2: Pruner ──────────────────────────────────────────────────────────
FROM node:22-slim AS pruner

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ─── Stage 3: Runner ──────────────────────────────────────────────────────────
FROM node:22-slim AS runner

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
  git ca-certificates wget curl openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY --from=pruner --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
# Runtime reads this SQL file via __dirname; tsc does not copy non-TypeScript assets.
COPY --from=builder --chown=node:node /app/src/infrastructure/db/schema.sql ./dist/infrastructure/db/schema.sql
COPY --chown=node:node package.json ./
COPY --chown=node:node caf.config.yaml ./

RUN mkdir -p /workspace && chown node:node /workspace
RUN mkdir -p /home/node/.ssh && chown node:node /home/node/.ssh
# CAF-DASHBOARD-01: db.path (caf.config.yaml) resolves to /app/data — must
# exist and be node-owned before the dashboard_db volume mounts over it
# (docker-compose.yml), otherwise the mount point defaults to root-owned and
# the non-root `node` user below can't write the SQLite file.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

EXPOSE 3030

# Healthcheck for the Fastify API
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3030/health || exit 1