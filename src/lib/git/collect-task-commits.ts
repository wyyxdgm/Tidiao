// R158 (damo 2026-09-26): 自动收集 commit —— agent 退出时跑 `git log base..head`
// 把区间内未声明的 commit 落进 task_commits. 消除 R113 "agent 未声明 git 提交"
// 这个 UI 空状态: marker 是 agent 主动声明通道, 自动收集是兜底, 两者并存.
//
// 设计权衡:
//   - 覆盖 R113 E 列第 4 条 "不主动跑 git log": damo 2026-09-26 拍板明示,
//     「commit 自动化」的目标就是让这条失效 —— task 的 cwd 是用户项目目录, 不是
//     "别人目录", 跑 git log 安全 (其他面板早就这么干: 文件变更/ProjectBoard
//     timeline/checkpoints).
//   - INSERT OR IGNORE 而非 upsert: marker 声明的 commit 通常带更精细的 desc
//     和 files 数组, 自动收集只填 marker 没写的, 不能反向覆盖 marker 数据.
//     因此新 DB helper `insertTaskCommitIgnore` (而非复用 upsertTaskCommit)
//     是必须的.
//   - 不拉文件清单 (不调 `git show --name-only`): 一是少一次 git 调用降开销,
//     二是 marker 没写 files 属性的语义才是「agent 没标注」, 自动收集的
//     commit.files 默认空 = 「不在 marker 中」的真实信号. UI 「无文件清单」
//     提示文案保留 (右栏 CommitEntryCard 行为不变).
//   - 不跑在 task.cwd 之外的目录: cwd 来自 task row, 已被 access control 限定,
//     不引入新的注入面.

import { execFileSync } from "child_process";
import { getDb } from "@/lib/db/index";
import { insertTaskCommitIgnore } from "@/lib/db/task-commits";

export interface CollectedCommit {
  commit_id: string;
  desc: string | null;
  files: string[];
}

export interface CollectOptions {
  /** 只收该时刻之后的 commit（ISO 或 "YYYY-MM-DD HH:MM:SS"）。传给 git log --since。 */
  since?: string | null;
}

/**
 * 读一条 commit 的 committer 时刻 (ISO 8601)。失败 (非 git 仓 / hash 不存在)
 * 返回 null, 调用方自行兜底。
 */
export function gitCommitTime(
  cwd: string,
  hash: string,
  timeoutMs = 5000,
): string | null {
  try {
    return execFileSync(
      "git",
      ["-C", cwd, "show", "-s", "--format=%cI", hash],
      { cwd, timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
    ).trim();
  } catch {
    return null;
  }
}

/**
 * 跑 `git log base..head --no-merges` 解析出区间内的 commit.
 * 返回的 commit 按 **逆序** (newest first, 跟 git log 默认输出一致) ——
 * 与 DB 层 getTaskCommitsByTaskId ORDER BY created_at DESC 的展示顺序
 * 对齐. 每条 commit:
 *   - commit_id: 全长 hash (来自 %H)
 *   - desc: commit subject 第一行, 截断到 512 字符 (与 marker 的 desc 同 cap)
 *   - files: 始终空数组 (设计权衡见文件头注释)
 *
 * 失败兜底 (cwd 非 git repo / git 不可用 / 命令超时) 返回 []. 调用方据此
 * 静默跳过, 不抛错, 不污染 task 状态.
 */
export function collectCommitsInRange(
  cwd: string,
  base: string,
  head: string,
  timeoutMs = 5000,
  opts?: CollectOptions,
): CollectedCommit[] {
  if (!cwd || !base || !head || base === head) return [];
  try {
    // %H = full hash, %s = subject. \t 分隔, 一行一 commit. --no-merges 跳过
    // merge commit (R113 拍板: agent task 内出现 merge bubble 是噪音, 不该
    // 让 fork 拓扑 / 派生 task 看到无意义的 merge 节点).
    //
    // R228: --since 时间下界。共享仓库多任务并发时, base 是 start 时刻锚点,
    // 长生命周期 task 的 resume 期间其他 task 在同一仓库的 commit 也会落进
    // base..head 区间, 全被认领 (AO-DEV R228: 89 条里 80+ 是 R30/R88/R92 的).
    // --since=本轮 started_at 把收集窗口压回「本 task 会话期间」.
    const args = ["log", "--no-merges", "--format=%H%x09%s"];
    if (opts?.since) args.push(`--since=${opts.since}`);
    args.push(`${base}..${head}`);
    const out = execFileSync("git", args, {
      cwd,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    const commits: CollectedCommit[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tab = trimmed.indexOf("\t");
      if (tab < 0) continue;
      const hash = trimmed.slice(0, tab);
      const subject = trimmed.slice(tab + 1).trim();
      if (!/^[0-9a-f]{7,64}$/.test(hash)) continue;
      commits.push({
        commit_id: hash.toLowerCase(),
        desc: subject ? subject.slice(0, 512) : null,
        files: [],
      });
    }
    return commits;
  } catch {
    return [];
  }
}

/**
 * 收尾: 给定 taskId + cwd + base/head 区间, 收集 commits 并 insert IGNORE.
 * 返回**新增行数** (= marker 没声明且 DB 没有的 commit 数), 给日志/UI 反馈.
 *
 * 单条失败 (极少见, e.g. DB 写异常) 不阻断其他 commit —— 走 INSERT OR IGNORE
 * 路径本身就幂等, 失败仅跳过这一条.
 */
export function backfillTaskCommits(
  taskId: string,
  cwd: string,
  base: string,
  head: string,
  opts?: CollectOptions,
): number {
  const commits = collectCommitsInRange(cwd, base, head, 5000, opts);
  let inserted = 0;
  for (const c of commits) {
    try {
      // R228: 先到先得 —— 同一 commit 已被其他 task 认领时跳过, 不重复归属.
      // 共享仓库并发 task 各自跑 base..head 收集, 同一条 commit 会被每个
      // 处于会话窗口内的 task 各认领一次 (实测: 一条 commit 被 9 个 task
      // 认领). marker 声明 (upsertTaskCommit) 不走这条路径, 不受影响.
      const claimed = getDb()
        .prepare(
          `SELECT 1 FROM task_commits WHERE commit_id = ? AND task_id != ? LIMIT 1`,
        )
        .get(c.commit_id, taskId);
      if (claimed) continue;
      const didInsert = insertTaskCommitIgnore({
        task_id: taskId,
        commit_id: c.commit_id,
        desc: c.desc,
        files: c.files,
      });
      if (didInsert) inserted++;
    } catch {
      // 单条失败不影响其他 commit; 主路径上 insertTaskCommitIgnore 已 try
      // 捕获, 这里的 catch 兜底是防止未来 DB helper 改动抛异常.
    }
  }
  return inserted;
}