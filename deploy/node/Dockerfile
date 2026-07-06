# SPDX-License-Identifier: AGPL-3.0-or-later
# Build from the repo root: docker build -f deploy/node/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.base.json ./
COPY src ./src
COPY deploy/node ./deploy/node
RUN npm run build:node

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
EXPOSE 8080
# Migrate-then-serve: same plain .sql migrations wrangler applies on Cloudflare.
CMD ["sh", "-c", "node dist/deploy/node/migrate.js && node dist/deploy/node/server.js"]
