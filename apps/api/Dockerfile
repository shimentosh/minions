# Minions API. Build context: the repository root.
#   docker build -f apps/api/Dockerfile .
# Applies pending database migrations on start, then serves on :4600.

FROM node:24-slim AS build
ENV CI=true
RUN npm install -g pnpm@11.5.3
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core packages/core
COPY apps/api apps/api
# The API and the workspace packages it needs, nothing else (no web, desktop, extension).
RUN pnpm install --frozen-lockfile --filter "@minions/api..."
RUN pnpm --filter @minions/core build \
 && pnpm --filter @minions/api exec prisma generate \
 && pnpm --filter @minions/api build

FROM node:24-slim
ENV NODE_ENV=production PORT=4600
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/apps/api
EXPOSE 4600
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4600/health',{headers:{'x-minions-client':'health'}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
