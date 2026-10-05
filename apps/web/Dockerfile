# Minions web app, served by nginx, which also proxies /api to the API
# container. Build context: the repository root.
#   docker build -f apps/web/Dockerfile .

FROM node:24-slim AS build
ENV CI=true
RUN npm install -g pnpm@11.5.3
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile --filter "@minions/web..."
# Same origin: the browser calls /api/..., nginx forwards it. The image then
# works on any domain.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @minions/core build && pnpm --filter @minions/web build

FROM nginx:1.28-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO /dev/null http://127.0.0.1/ || exit 1
