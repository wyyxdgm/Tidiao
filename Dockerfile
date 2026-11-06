# R153 phase 1a — multi-stage build for the Next.js Standalone output.
#
# Stage 1 (builder): installs deps + runs `next build` (which emits
#   dist/standalone/ + dist/static/). After build we strip the cruft that
#   Next.js output file tracing copies from the workspace (whole src/ tree,
#   .git/, *.test.ts, .env*, docs/, scripts/, ...). We keep only what
#   server.js actually requires at runtime: server.js + dist/ + node_modules/.
#
# Stage 2 (runner): node:20-alpine slim runtime, COPY only the trimmed
#   artifacts from builder. Final image excludes source/tests/git per AC8.

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

# Copy the rest of the source (excluding .dockerignore'd paths)
COPY . .

# Build = emits dist/standalone/ (server.js + traced deps + traced src) and dist/static/
RUN npm run build

# Trim dist/standalone cruft. Next 16 sets outputFileTracingRoot=workspace,
# so the tracer copies the whole repo into the standalone output. We keep
# only the four entries server.js needs:
#   - server.js         (entry point)
#   - dist/             (build manifest dir; server.js uses distDir="./dist")
#   - node_modules/     (pnpm store with traced deps incl. better-sqlite3)
#   - package.json      (optional; lets `npm start` work too)
# Everything else (.git, src/, .env*, docs/, scripts/, *.test.ts, ...) is
# removed here so it never reaches the runner stage.
RUN find dist/standalone -mindepth 1 -maxdepth 1 \
      ! -name 'server.js' \
      ! -name 'dist' \
      ! -name 'node_modules' \
      ! -name 'package.json' \
      -exec rm -rf {} +

# Belt-and-suspenders: scrub any test files / .git dirs that may have leaked
# via tracing (file-level, in case anything slipped past the top-level prune).
RUN find dist/standalone -type d -name '.git' -prune -exec rm -rf {} +
RUN find dist/standalone -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.mjs' \) -delete
RUN rm -rf dist/standalone/.next dist/standalone/.claude dist/standalone/instrumentation.ts

# Drop the dead-weight native binaries that aren't used at runtime on alpine:
#   - sharp glibc variants (alpine uses musl; sharp auto-picks the right one)
#   - sharp itself + @img + color-convert + detect-libc (sharp is only loaded
#     if Next.js Image Optimization kicks in; this backend doesn't use next/image)
#   - onnxruntime-web + @xenova/transformers + @huggingface (embeddings use
#     a JS fallback when the native binary is missing; login endpoint never
#     touches them). Saves ~33MB uncompressed.
# Verified by `docker export|import` smoke test (login endpoint still 401s,
# no native-module import errors) — see scripts/docker-smoke.sh AC7 check.
RUN rm -rf node_modules/@img \
          node_modules/sharp \
          node_modules/detect-libc \
          node_modules/color-convert \
          node_modules/onnxruntime-web \
          node_modules/onnxruntime-common \
          node_modules/@xenova \
          node_modules/@huggingface

# === Stage 2: runner ===
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV ORCHESTRATOR_HOME=/app/data

# Copy only the trimmed standalone artifacts + static assets + public files.
COPY --from=builder /app/dist/standalone/server.js ./server.js
COPY --from=builder /app/dist/standalone/dist ./dist
COPY --from=builder /app/dist/standalone/node_modules ./node_modules
COPY --from=builder /app/dist/standalone/package.json ./package.json
COPY --from=builder /app/dist/static ./dist/static
COPY --from=builder /app/public ./public

EXPOSE 3000

# Run as non-root for defense-in-depth (still WIP — better-sqlite3 needs writable /app/data).
# USER node

CMD ["node", "server.js"]