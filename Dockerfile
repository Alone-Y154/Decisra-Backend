# syntax=docker/dockerfile:1

# Build TypeScript + install dependencies.
# Uses Node 20+ because this project relies on global fetch() (Daily API calls).

FROM node:20-alpine AS base
WORKDIR /app

# ----- Build deps (includes devDependencies) -----
FROM base AS build-deps
COPY package.json package-lock.json ./
RUN npm ci

# ----- Build -----
FROM build-deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ----- Production deps (no devDependencies) -----
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ----- Runtime -----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Default in src/utils/env.ts is 4000
EXPOSE 4000

CMD ["node", "dist/server.js"]
