# 提调（Tidiao）· AI Agent Task Orchestrator

A self-hosted task orchestrator for **Claude Code agents**: dispatch coding tasks from a web UI, watch them stream live, review & approve the results. Web UI + Agent SDK + SQLite, with auth & multi-tenancy built in.

> Tidiao (提调) = the Ming-era "tidiao" official in charge of dispatch & coordination — the platform's job in one word. Feature terms keep the ancient tiger-tally metaphor: dispatch = 授符 (issue the tally), verify = 合符 (match the two halves), agent = 虎贲 (the tally-runner).

## What it does

- **Dispatch** — create tasks (with prompt, repo cwd, model config) and queue them to Claude Code agents (`query()`-driven, streaming via SSE)
- **Watch** — live task panel: streaming output, turn/tool events, commit collection per task
- **Review** — task lifecycle: queued → running → reviewing → done, with approve / refine / fork / resume
- **Fork & checkpoints** — branch a session at any point; file checkpointing via Agent SDK
- **Projects & versions** — organize tasks under projects (bound to repo cwd), optional versions
- **Project wiki** — render `INDEX.md`-rooted markdown wiki per project, cross-project links
- **Schedules** — cron / one-shot jobs running agent prompts or shell commands, anti-pileup guards
- **Intake channels** — webhook/telegram/wecom intake → auto-create tasks (bring your own bot)
- **Feishu sync** — mirror task boards to Feishu sheets (optional)
- **Multi-tenant** — JWT auth, all data isolated by owner; first registered user becomes admin
- **LLM provider catalog** — built-in catalog of model providers (Anthropic, Ark, and more), BYO API keys, encrypted at rest
- **SPA UI** — Vue 3 single-page app served by the same Next.js server

## Quick start

```bash
npm install
npm run build:spa    # build the Vue web UI into public/ (first time; re-run after UI changes)
npm run dev          # → http://localhost:13000
```

Open http://localhost:13000, register (first user = admin), add an LLM provider key in Settings, create a Project (point `cwd` at a git repo on this machine), then dispatch your first task to a Claude Code agent.

Requirements: Node ≥ 20, a Claude Code installation (or Anthropic-compatible API key), git.

**BYOK**: the orchestrator carries no inference cost of its own — you plug in your own API keys; they are encrypted (AES) in SQLite.

## Docs

| Doc | Content |
|---|---|
| [`docs/usage/`](docs/usage/README.md) | User manual (13 chapters by module) |
| [`docs/architecture.md`](docs/architecture.md) | Architecture + data model |
| [`docs/api-routes.md`](docs/api-routes.md) | API routes reference |
| [`docs/agent-sdk-patterns.md`](docs/agent-sdk-patterns.md) | Agent SDK integration patterns (streaming input, canUseTool, fork) |
| [`docs/workflow.md`](docs/workflow.md) | Delivery lifecycle (task types, review loop) |

## Status

First public release (v0.1.0). This is a single-maintainer project — issues are read but PRs are not accepted for now. Development happens in the open from here on.

## License

[Apache-2.0](LICENSE)
