# Use Node.js LTS
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Build the app
RUN pnpm build

# Final image
FROM node:20-slim
WORKDIR /app
COPY --from=base /app /app

EXPOSE 3000
CMD ["pnpm", "start"]
