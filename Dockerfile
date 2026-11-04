# syntax=docker/dockerfile:1
# Production image for Dokploy (or any Docker host). Postgres comes from DATABASE_URL; migrations run on every start.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies only. tsx (TypeScript runtime) and drizzle-kit (migrations) are runtime dependencies on purpose.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-bookworm-slim
# tini as PID 1: forwards SIGTERM to node and reaps zombies, so Dokploy redeploys stop the container cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    TRUST_PROXY=1 \
    RATE_LIMIT_STORE=db
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json tsconfig.json drizzle.config.ts ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node inventory ./inventory
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
RUN chmod +x scripts/docker-start.sh
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["scripts/docker-start.sh"]
