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
#
# 🔴 R153 实测补: 顺手删 SPA 的 .map —— 上面只删了 .next 里的 sourcemap, 但 vite
#   也会在 public/assets/ 里留 142 个 .map (26MB), 运行时完全用不上。
RUN cd spa && npm run build \
 && cd .. \
 && rm -rf public/assets && mkdir -p public/assets \
 && cp spa/dist/index.html public/index.html \
 && cp -R spa/dist/assets/. public/assets/ \
 && find public/assets -name '*.map' -delete

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

# git + bash —— 不是可选的。
#
# git: 平台到处 shell out 到 git (收集 task commit / 读 task 历史 / 项目 board 历史 /
#   cwd 不存在时自动 git clone)。镜像里没 git → 这些路径全部 ENOENT 崩。
#   R153 Docker 化实测: `command -v git` → MISSING。
# bash: Claude Code 的 BashTool 硬依赖 /bin/bash（SDK 内置 musl 二进制里能 grep 到
#   "/bin/bash" 硬编码），node 的 child_process shell:true 默认走 /bin/sh (ash)，
#   缺 bash 时 agent 的 bash 类工具与 schedule shell 任务行为跟宿主不一致。
#   另: 镜像里带了 claude-agent-sdk 的 musl 变体（alpine 用的就是它）。
#
# ca-certificates: 拉 LLM API / 远程 git clone 需要 TLS 根证书。
RUN apk add --no-cache git bash ca-certificates

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
# to JS when the native binary is absent.
#
# 🔴 R153 实测补: 顶层 onnxruntime-node（283MB 原生二进制）也一并删 —— 全仓 grep
#   只有 package.json/lockfile/Dockerfile 提到它, src/ 里零引用（@xenova/transformers
#   自带的嵌套 onnxruntime-node@1.14 才是真依赖, 但 @xenova 整体已删）。
#
# 🔴 R153 实测补: 删 @anthropic-ai/claude-agent-sdk-linux-x64（glibc 变体, 262MB）。
#   alpine 是 musl —— 那个二进制在容器里直接 exec 都失败:
#   `sh: /app/node_modules/.../claude: not found`（缺 glibc loader）。
#   留着的唯一效果是白占 262MB + 误导 SDK 去挑错二进制。musl 变体必须保留。
#
# 🔴 R153 实测补: npm cache 必须清 —— npm ci 会把 ~530MB 的 tarball cache 落在
#   /root/.npm/_cacache, 白占镜像体积且运行时用不上。
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && rm -rf node_modules/@img \
          node_modules/sharp \
          node_modules/detect-libc \
          node_modules/color-convert \
          node_modules/onnxruntime-web \
          node_modules/onnxruntime-common \
          node_modules/onnxruntime-node \
          node_modules/@xenova \
          node_modules/@huggingface \
          node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 \
 && npm cache clean --force \
 && rm -rf /root/.npm

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