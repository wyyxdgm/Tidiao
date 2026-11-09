# Multi-stage build for the Tidiao orchestrator.
#
# Stage 1 (builder): installs deps, builds the Vue SPA into public/, then runs
#   `next build`. Produces .next/ (server bundle + client chunks).
#
# Stage 2 (runner): node:22-alpine slim runtime with production-only deps and
#   the build output. Runs `next start` — the same entrypoint the pm2
#   deployment uses (ecosystem.config.cjs), so image and production behave
#   identically.
#
# Deliberately NOT `output: 'standalone'` — see the note on the build step.

# === Stage 1: builder ===
FROM node:22-alpine AS builder
WORKDIR /app

# Build deps for better-sqlite3 (native module compiled against musl libc).
# python3 + make + g++ are required by node-gyp; sqlite-dev provides the
# system SQLite headers better-sqlite3 links against. Kept here (not in
# runner) so the final image stays slim.
#
# node:22-alpine is required because better-sqlite3@13.x pins engine node>=22.
#
# The proxy args are optional — only used when the build host needs them to
# reach the npm registry / nodejs.org (e.g. WSL behind a corporate proxy).
# Pass with:  docker build --build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=...
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY}

RUN apk add --no-cache python3 make g++ sqlite-dev

# Install deps with lockfile fidelity.
# --ignore-scripts skips the onnxruntime-node postinstall (it tries to download
# a native binary from unofficial-builds.nodejs.org which sometimes returns
# 302 redirects the install script can't follow). Embeddings use a JS fallback
# when the native binary is missing; the platform smoke test (login endpoint)
# does not touch the embedding path.
#
# better-sqlite3 ships with prebuilt binaries for linuxmusl-x64 in prebuilds/,
# loaded at runtime via `require('../prebuilds/linuxmusl-x64.node')`. There is
# no `install` script, so --ignore-scripts leaves the prebuilt in place — no
# node-gyp rebuild needed.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts

# SPA (Vue 3) deps are a separate install tree (spa/package-lock.json).
# Installed before COPY . . so the layer caches across source edits.
COPY spa/package.json spa/package-lock.json ./spa/
RUN cd spa && npm ci --no-audit --no-fund

# Copy the rest of the source (excluding .dockerignore'd paths)
COPY . .

# Build the Vue SPA into public/ (index.html + assets/).
# The web UI is served by src/app/route.ts (root GET → public/index.html);
# without this the image boots but every page render returns 503 "SPA not built".
#
# Same result as the repo's `npm run build:spa`, minus its `npm install`
# (deps are already installed above via `npm ci`, and re-resolving them in
# the image would drift from the lockfile).
RUN cd spa && npm run build \
 && cd .. \
 && rm -rf public/assets && mkdir -p public/assets \
 && cp spa/dist/index.html public/index.html \
 && cp -R spa/dist/assets/. public/assets/

# Build the Next.js server.
#
# Deliberately NOT `output: 'standalone'`: Next 16's standalone output omits
# dist/server/instrumentation.js and the chunks it depends on (the standalone
# trace only covers modules reachable from a page route — instrumentation is
# not one). The runtime looks for dist/server/instrumentation.js, doesn't find
# it, and silently skips the startup hook — no DB init, no schedule runner,
# no WeChat worker, while the app still looks healthy.
# `next start` over .next/ is what the pm2 deployment uses (ecosystem.config.cjs),
# so the image and production behave identically.
RUN npm run build

# Sourcemaps are ~120MB of the build and useless at runtime.
RUN find .next -name '*.map' -delete

# === Stage 2: runner ===
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV ORCHESTRATOR_HOME=/app/data

# Production dependencies only (no devDeps: no typescript, no test tooling).
#
# --ignore-scripts skips the onnxruntime-node postinstall (it tries to download
# a native binary from unofficial-builds.nodejs.org which sometimes returns
# 302 redirects the install script can't follow). Embeddings use a JS fallback
# when the native binary is missing; the login endpoint never touches them.
#
# better-sqlite3 ships prebuilt binaries for linuxmusl-x64 in prebuilds/, loaded
# via require('../prebuilds/linuxmusl-x64.node'); it has no install script, so
# --ignore-scripts leaves the prebuilt in place — no node-gyp rebuild needed.
#
# The dropped packages are dead weight at runtime: sharp/@img are only loaded
# by Next.js Image Optimization (this backend doesn't use next/image), and
# onnxruntime-web/@xenova/@huggingface only serve embeddings, which fall back
# to JS when the native binary is absent. Saves ~33MB.
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && rm -rf node_modules/@img \
          node_modules/sharp \
          node_modules/detect-libc \
          node_modules/color-convert \
          node_modules/onnxruntime-web \
          node_modules/onnxruntime-common \
          node_modules/@xenova \
          node_modules/@huggingface

# The build output plus the config the server reads at startup.
# .next/server/instrumentation.js — the startup hook (DB init, schedule runner,
# WeChat worker) — ships inside .next/; the runtime loads it from there.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

# Run as non-root for defense-in-depth (still WIP — better-sqlite3 needs writable /app/data).
# USER node

CMD ["npx", "next", "start", "-p", "3000"]