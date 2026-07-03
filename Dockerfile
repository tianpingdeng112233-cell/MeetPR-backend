# syntax=docker/dockerfile:1.7
# Multi-stage build for MeetPR backend (Node 22 + pnpm + TypeScript)
# Target: Aliyun SAE serverless container runtime

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN npm pkg delete scripts.prepare && pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN npm pkg delete scripts.prepare && pnpm install --frozen-lockfile --prod

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
# Bundled plan-web frontend (built with VITE_API_BASE='' → same-origin).
COPY --chown=node:node web ./web
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
