# syntax=docker/dockerfile:1
# Production image: a long-running Node server. Server setup runs for 20–40 minutes over SSH and
# streams its logs, which is why this app needs a VPS rather than a serverless platform.

# ---- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- production dependencies ----
# The server bundle leaves ssh2, node-ssh, bullmq, ioredis and cloudflare unbundled
# (vite.config.ts nativeExternals), so they must be installed next to it.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.output ./.output
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
