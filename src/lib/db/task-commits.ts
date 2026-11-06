// Task commits CRUD operations (R113, 2026-09-07).
//
// task_commits 表存储 agent 在 transcript 里写的 `<git commit-id="..." desc="..." files="..."/>`
// marker. 每次 marker 解析命中 → upsert 一行 (PK = task_id + commit_id, 重复写覆盖 desc/files).
//
// 数据采集原则:
//   - 不主动跑 git 命令 (严守 damo R113 E 列第 4 条 "不到别人目录里跑 git")
//   - 完全 agent 驱动: marker 写没写决定这条 commit 是不是被记录
//   - 没写 marker 的 task → Commits Chain 显示 "agent 未声明 git 提交" 提示, 不报错
//
// UI / API 用法:
//   - getTaskCommitLog(taskId): 返回该 task 的 commits (按 created_at DESC), 可选 include
//     派生 task 的 commits (沿 forked_from_session_id 递归, CTE 在 API 层做).

import { getDb } from "./index";

export interface TaskCommit {
  task_id: string;
  commit_id: string;
  desc: string | null;
  files_json: string | null;
  created_at: string;
}

export interface CommitLogEntry extends TaskCommit {
  // Parsed files array — convenience accessor. callers may use files_json
  // directly when they want the raw stored value (e.g. for re-serialization).
  files: string[];
}

function parseFiles(filesJson: string | null): string[] {
  if (!filesJson) return [];
  try {
    const v = JSON.parse(filesJson);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Upsert: same (task_id, commit_id) → overwrite desc/files_json + bump created_at.
// Agent might re-emit the same commit marker on a resume / retry; we want the
// latest desc + files (don't keep stale data).
//
// Note: SQLite UPSERT is atomic; no race between concurrent marker parses on
// the same transcript because the parser is single-threaded per session.
export function upsertTaskCommit(input: {
  task_id: string;
  commit_id: string;
  desc?: string | null;
  files?: string[];
}): TaskCommit {
  const db = getDb();
  const filesJson = input.files && input.files.length > 0
    ? JSON.stringify(input.files)
    : null;
  db.prepare(`
    INSERT INTO task_commits (task_id, commit_id, desc, files_json, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(task_id, commit_id) DO UPDATE SET
      desc = excluded.desc,
      files_json = excluded.files_json,
      created_at = datetime('now')
  `).run(
    input.task_id,
    input.commit_id,
    input.desc ?? null,
    filesJson,
  );
  const row = db
    .prepare("SELECT * FROM task_commits WHERE task_id = ? AND commit_id = ?")
    .get(input.task_id, input.commit_id) as TaskCommit | undefined;
  if (!row) throw new Error("upsertTaskCommit: failed to read back row");
  return row;
}

// Get all commits for a single task (no descendants). Order: newest first
// (created_at DESC) — matches "git log" mental model.
export function getTaskCommitsByTaskId(taskId: string): CommitLogEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM task_commits WHERE task_id = ? ORDER BY datetime(created_at) DESC, commit_id ASC",
    )
    .all(taskId) as TaskCommit[];
  return rows.map((r) => ({
    ...r,
    files: parseFiles(r.files_json),
  }));
}

// R158 (damo 2026-09-26): 自动化 commit 收集的 DB 入口. 与 upsertTaskCommit
//   的区别: marker 声明的 commit 通常带更精细的 desc + files 数组 (agent 主动
//   标注), 自动收集只填 marker 没写的——不能反向覆盖 marker 数据. 因此走
//   INSERT OR IGNORE, 已存在行零写入, desc/files 完全保留.
//   返回 boolean: true=新插入, false=已存在 (含 marker 声明的情况).
//   调用方据此统计新增条数, 日志/UI 反馈.
export function insertTaskCommitIgnore(input: {
  task_id: string;
  commit_id: string;
  desc?: string | null;
  files?: string[];
}): boolean {
  const db = getDb();
  const filesJson =
    input.files && input.files.length > 0
      ? JSON.stringify(input.files)
      : null;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO task_commits (task_id, commit_id, desc, files_json, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      input.task_id,
      input.commit_id,
      input.desc ?? null,
      filesJson,
    );
  return result.changes > 0;
}
