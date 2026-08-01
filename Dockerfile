ARG NODE_VERSION=24.15.0
ARG PNPM_VERSION=11.18.0

FROM ghcr.io/astral-sh/uv:0.12.0 AS uv
FROM node:${NODE_VERSION}-bookworm-slim AS base

ARG NODE_VERSION
ARG PNPM_VERSION

# Install uv and the pinned pnpm version
COPY --from=uv /uv /uvx /bin/
RUN apt-get update && apt-get install -y \
    curl \
    && npm install -g "pnpm@${PNPM_VERSION}" \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED 1

# Copy root package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./

# Copy package.json files from all workspaces
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/
COPY packages/eslint-config/package.json ./packages/eslint-config/
COPY packages/trpc/package.json ./packages/trpc/
COPY packages/typescript-config/package.json ./packages/typescript-config/
COPY packages/zod-types/package.json ./packages/zod-types/

# Install dependencies
RUN CI=true pnpm install --frozen-lockfile

# Builder stage
FROM base AS builder
WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /app/packages ./packages

# Copy source code
COPY . .

# Build all packages and apps
RUN pnpm build

RUN set -eu; \
    next_dir="apps/frontend/node_modules/next"; \
    from="proxyTimeout: proxyTimeout === null ? undefined : proxyTimeout || 30000,"; \
    to="proxyTimeout: proxyTimeout === null ? undefined : proxyTimeout || 600000,"; \
    for file in \
        "$next_dir/dist/server/lib/router-utils/proxy-request.js" \
        "$next_dir/dist/esm/server/lib/router-utils/proxy-request.js"; do \
        test -f "$file" || { echo "Missing Next proxy file: $file" >&2; exit 1; }; \
        grep -qF "$from" "$file" || { echo "Missing expected timeout source in: $file" >&2; exit 1; }; \
        sed -i "s#$from#$to#" "$file"; \
        grep -qF "$to" "$file" || { echo "Failed to patch timeout in: $file" >&2; exit 1; }; \
        ! grep -qF "$from" "$file" || { echo "Original timeout remains in: $file" >&2; exit 1; }; \
        test "$(grep -Fc "$to" "$file")" -eq 1 || { echo "Unexpected patched timeout count in: $file" >&2; exit 1; }; \
    done

# Production runner stage
FROM base AS runner
WORKDIR /app

# OCI image labels
LABEL org.opencontainers.image.source="https://github.com/tossp/metamcp"
LABEL org.opencontainers.image.description="MetaMCP - aggregates MCP servers into a unified MetaMCP"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="MetaMCP"
LABEL org.opencontainers.image.vendor="tossp"

# Install curl for health checks
RUN apt-get update && apt-get install -y curl postgresql-client && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user with proper home directory
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --home /home/nextjs nextjs && \
    mkdir -p /home/nextjs/.cache/node/corepack /home/nextjs/.cache/uv && \
    chown -R nextjs:nodejs /home/nextjs

# Copy built applications
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontend/package.json ./apps/frontend/
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/package.json ./apps/backend/
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=builder --chown=nextjs:nodejs /app/apps/backend/drizzle.config.ts ./apps/backend/

# Copy built packages
COPY --from=builder --chown=nextjs:nodejs /app/packages ./packages
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./
COPY --from=builder --chown=nextjs:nodejs /app/pnpm-lock.yaml ./
COPY --from=builder --chown=nextjs:nodejs /app/pnpm-workspace.yaml ./

# Install production dependencies only
RUN CI=true pnpm install --prod --frozen-lockfile && \
    chown -R nextjs:nodejs /app

# Copy startup script
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER nextjs

# Expose frontend port (Next.js)
EXPOSE 12008

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:12008/health || exit 1

# Start both backend and frontend
CMD ["./docker-entrypoint.sh"]
