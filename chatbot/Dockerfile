# Multi-stage build for the úlovdomov chatbot — produces a slim runtime image
# suitable for Azure App Service / Container Apps. The chatbot ships as a
# library + CLI; this image exposes the CLI by default. Wrap with a thin HTTP
# server (Express / Fastify) when deploying as a service.

FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifest first so dependency installation is cached across code changes.
COPY package.json ./

# `npm install` (not `npm ci`) — the repo intentionally does not commit
# package-lock.json (see .gitignore). For reproducible production images,
# uncomment the COPY package-lock.json line and switch to `npm ci`.
# COPY package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force

# ─── runtime ───
FROM node:20-alpine AS runtime

WORKDIR /app

# Bring in the installed node_modules + the chatbot source tree.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src/ ./src/
COPY knowledge-base/ ./knowledge-base/

# Re-install only tsx (dev dep skipped in deps stage) so the entry point
# runs without an explicit transpile step + create a non-root user.
# For a heavier production setup, pre-compile to dist/ via `npm run build`
# and switch the ENTRYPOINT to `node dist/server.js`.
RUN npm install --no-save tsx && \
    addgroup -S chatbot && \
    adduser -S chatbot -G chatbot && \
    chown -R chatbot:chatbot /app
USER chatbot

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Default entry point — HTTP server (POST /chat, GET /health, /ready, /metrics).
# To run the interactive CLI instead, override at deploy / docker-run time:
#   docker run --entrypoint "npx" <image> tsx src/cli.ts
ENTRYPOINT ["npx", "tsx", "src/server.ts"]
