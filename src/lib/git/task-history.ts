// whoTouchedThis — find historical tasks that touched a file.
// Derives "touched" from git diff base..head (no R113 marker dependency).
//
// 功能: 反查 "哪些历史 task 改过这个文件",给 agent 按需感知代码历史用.
// 关注点:
//   - 不用 task_commits 表 (R113 marker adoption = 0%, 实测 — simulate-who-touched.sh).
//   - 用 tasks.base_commit + head_commit (91.8% 任务有, active-session.ts:1925,1938)
//     + `git diff base..head --name-only -- <file>` 派生,git diff 是真理.
//   - 不依赖 agent 任何操作 (不像 v1 marker 方案要 agent 主动 opt-in).
//   - 失败 graceful: cwd 不可访问 / head 不可达 (amend/分支删) / 非 git 仓 / git 命令
//     抛错 → 静默跳过该 task,返 null;绝不阻断 route 调用.
//   - LRU 缓存防同一 process 重复 git diff (验证 F 显示 ~110ms/查询,缓存后 ~0ms).
//   - 所有 SQL clause 来自 scripts/validate-who-touched-v2.sh 10 维度验证.

import { execFileSync } from "child_process";

export interface TaskHistoryEntry {
  task_id: string;
  title: string;
  status: string;
  completed_at: string | null;
  cwd: string;
  base_commit: string;
  head_commit: string;
}

export interface TaskLookup {
  id: string;
  cwd: string;
  base_commit: string;
  head_commit: string;
}

const GIT_TIMEOUT_MS = 5000;
const CACHE_MAX_ENTRIES = 1024;

/**
 * Bound a Map by LRU eviction. Returns a Map whose `.set(key, value)` evicts
 * the oldest insertion when size exceeds max. Order is preserved by Map's
 * insertion-order semantics.
 */
function lruMap<V>(): Map<string, V> {
  const m = new Map<string, V>();
  const origSet = m.set.bind(m);
  m.set = (key: string, value: V): Map<string, V> => {
    if (m.size >= CACHE_MAX_ENTRIES && !m.has(key)) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined) m.delete(oldest);
    }
    return origSet(key, value);
  };
  return m;
}

const fileTouchedCache = lruMap<boolean>();
const filesListCache = lruMap<string[] | null>();

/**
 * Run `git -C <cwd> diff --name-only <base>..<head> -- <file>` and return true
 * iff the file appears in the diff output.
 *
 * 失败 graceful: cwd 不可访问 / 非 git 仓 / git 命令超时/抛错 → 返 false, 不抛.
 * caller 不需要 try/catch,route 层无需判 null.
 *
 * 用 -- 分隔强制 git 把 <file> 当字面量, 不论 [ ] / 中文 / 空格 都被 git 当
 * pathspec 处理 (实测 0/2665 task-touched 文件有中文或空格,但 4% 有 [id] 路径,
 * 仍走 -- 保安全).
 */
export function taskTouchedFile(task: TaskLookup, file: string): boolean {
  // 防御性: 空 cwd / 空 commit 必返 false,避免 `git diff` 空 args 抛
  if (!task.cwd || !task.base_commit || !task.head_commit || !file) return false;
  const key = `${task.cwd}::${task.base_commit}..${task.head_commit}::${file}`;
  const cached = fileTouchedCache.get(key);
  if (cached !== undefined) return cached;

  let touched = false;
  try {
    const out = execFileSync(
      "git",
      ["-C", task.cwd, "diff", "--name-only", `${task.base_commit}..${task.head_commit}`, "--", file],
      { timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
    );
    touched = out.trim().length > 0;
  } catch {
    // git 抛错 (cwd 不可达 / commit 不存在 / 超时) → 当作 "没碰过"
    // 不抛, 不 log, 不写 events (事件落库在 route 层做,这里只关心查询).
    touched = false;
  }
  fileTouchedCache.set(key, touched);
  return touched;
}

/**
 * Fetch all files touched by a single task (full list, not filtered by -- <file>).
 * 用作 whoTouchedThis 的反向: 已知 task,列出它所有碰过的文件.
 * 用途: 将来 task detail 页加 "files changed" tab 时复用.
 *
 * 失败 graceful: 返 null.
 */
export function getFilesTouchedByTask(task: TaskLookup): string[] | null {
  if (!task.cwd || !task.base_commit || !task.head_commit) return null;
  const key = `FILES:${task.cwd}::${task.base_commit}..${task.head_commit}`;
  const cached = filesListCache.get(key);
  if (cached !== undefined) return cached;

  let files: string[] | null = null;
  try {
    const out = execFileSync(
      "git",
      ["-C", task.cwd, "diff", "--name-only", `${task.base_commit}..${task.head_commit}`],
      { timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
    );
    files = out.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch {
    files = null;
  }
  filesListCache.set(key, files);
  return files;
}

/**
 * Test seam: clear the in-process LRU cache. Tests use this to assert that
 * repeated calls don't re-execute git; production code should not call it.
 */
export function _clearTaskHistoryCacheForTests(): void {
  fileTouchedCache.clear();
  filesListCache.clear();
}