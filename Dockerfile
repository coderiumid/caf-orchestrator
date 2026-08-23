# syntax=docker/dockerfile:1

# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

# ─── Stage 2: Pruner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS pruner

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
COPY --chown=node:node package.json ./
COPY --chown=node:node caf.config.yaml ./

RUN mkdir -p /workspace && chown node:node /workspace
RUN mkdir -p /home/node/.ssh && chown node:node /home/node/.ssh

USER node

ENV NODE_ENV=production
ENV WORKSPACE_DIR=/workspace

EXPOSE 3030

# Healthcheck for the Fastify API
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3030/health || exit 1