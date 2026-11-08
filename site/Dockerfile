# Static export (next.config.ts `output: 'export'`) served by nginx.
# `next start` refuses a static export, so the auto-detected Node build can't run it.
FROM oven/bun:1.3.11 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN node node_modules/next/dist/bin/next build

FROM nginx:1.29-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO /dev/null http://127.0.0.1/ || exit 1
