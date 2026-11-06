// CLI 会话历史导入 API — 对应 master src/app/api/cli-import/route.ts (GET 状态 / POST 启动 sync).
//
// 功能: 把本机原生 Claude Code CLI 的会话历史 (~/.claude/projects/) 一键导入为平台任务.
// 一个 session = 一个 completed 任务, 带 LLM 摘要, transcript 硬链接零拷贝可直接查看.
//
// 关注点:
// - 状态是单机全局的 (后端 state.json), 不分用户; POST 用的 owner = 当前会话用户.
// - POST 已在跑时后端返回 409 + 当前 state, 调用方直接回落到轮询显示即可.
// - 详见 docs/usage/08-import-sync.md「本机 CLI 会话历史导入」.

import { get, post } from './http';

export interface CliImportState {
  running: boolean;
  phase: 'scan' | 'summarize' | 'ingest' | 'done' | 'error' | null;
  message?: string;
  started_at?: string;
  finished_at?: string;
  stats?: { imported: number; skipped: number; projects_created: number };
}

export function getCliImportState() {
  return get<CliImportState>('/api/cli-import');
}

export function startCliImport() {
  return post<{ ok: boolean }>('/api/cli-import');
}
