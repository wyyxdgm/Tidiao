# Changelog

## v0.1.0 — First public release (2026-11-06)

Initial public snapshot of 提调 (Tidiao, formerly "Hufu"), a self-hosted AI agent task orchestrator for Claude Code.

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
