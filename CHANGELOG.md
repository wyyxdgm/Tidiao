# Changelog

## v0.2.0 — Docker distribution + Claude Code skills/CLI (2026-11-09)

Distribution and operability release. Self-hosting no longer requires a Node toolchain on the host.

New in this release:

- **Container image** — published to `ghcr.io/wyyxdgm/tidiao` (`latest` tracks `main`; every `v*` tag gets a matching version tag). Bundles the Vue web UI and the Next.js server; `docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d` is the whole setup. See [README](README.md#run-with-docker).
- **Claude Code skills** — 8 `orchestrator-*` skills (`.claude/skills/`) plus a unified CLI (`scripts/ao`) so an agent can dispatch, query, act on, and monitor tasks directly from the platform.
- **Bilingual web UI** — the Vue SPA is fully localized (zh-CN / en-US) with a language toggle in the header and Settings.

Fixes in this release:

- **Docker image had no web UI** — the build never ran `npm run build:spa`, so `public/index.html` was missing and every page render returned 503. The builder stage now builds the SPA.
- **Docker image never ran the startup hook** — `instrumentation.ts` was excluded from the build context, so the container started without DB initialization, the schedule runner, or the WeChat intake worker. It is now compiled in, and the image runs `next start` (the same entrypoint as the pm2 deployment) so image and production behave identically.
- **`.dockerignore` matched only the context root** — `spa/node_modules` (host macOS binaries, ~370MB) was copied over the Alpine install; nested trees are now excluded with `**/` patterns.

Known limitation:

- The image is ~1.9GB. It ships the full production dependency tree (the Claude Agent SDK alone is ~260MB, and the `onnxruntime-node` native binaries add ~280MB without being imported anywhere). Slimming it further means dropping unused dependencies from `package.json` — separate work, deliberately not mixed into this release.

## v0.1.0 — First public release (2026-11-06)

Initial public snapshot of 提调 (Tidiao), a self-hosted AI agent task orchestrator for Claude Code.

Core capabilities in this release:

- Task dispatch to Claude Code agents with live SSE streaming
- Task lifecycle: queued / running / reviewing / done, approve-refine-fork-resume loops
- Session fork & file checkpointing (Agent SDK)
- Projects / versions bound to repo working directories
- Per-project wiki (markdown, cross-project links)
- Cron & one-shot schedules (agent prompts or shell commands)
- Intake channels (webhook / telegram / wecom) with configurable routing
- Feishu sheet sync for task boards
- JWT auth + multi-tenant data isolation (first user = admin)
- LLM provider catalog with BYO keys, AES-encrypted at rest
- Vue 3 SPA served by the Next.js server

Notes:

- Internal deployment/ops scripts are not part of this snapshot. Self-hosting = `npm install` → `npm run build:spa` (web UI) → `npm run dev` (or `npm run build` + `npm start`).
