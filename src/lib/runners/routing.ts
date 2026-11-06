// R3 路由决策: 给定 project 配置 + Bash 命令, 决定走本地 SDK 还是哪个 runner.
//
// 功能:
//   - resolveRunnerRoute(project, command) → RouteResolution
//   - 三种结果:
//     - null: 无白名单命中 → Bash 走本地 SDK (现有路径, 不动)
//     - { runner: null, reason }: 白名单命中但所有候选 runner 都 offline/dead → canUseTool deny
//     - { runner, cwdMapping }: 白名单命中 + runner online → canUseTool 在 runner 上执行
//
// 关注点:
//   - 纯函数, 不依赖 DB / fetch. 纯函数模块风格照 deploy-guard.ts.
//   - command_patterns 匹配: "先 escape 再 .* 拼, 匹配'前缀包含'"
//     (rollout §5 R3 / docs/plans/runners.md §Task R3 step 2). 不写正则
//     验证 = 让用户写 prefix 就行, 不要写出 /^echo.*/ 这种东西.
//   - 候选 runner 按 runner_id 字典序排序取第一个 (operator 可预测).
//   - "全 offline" 包括 online/offline/dead 任何状态中可用的 = 没, 都算 offline
//     (白名单命中但没 runner 可用一律 deny; 不静默 fallback).
//   - project.runners JSON 解析失败 → null (按"未配 runner"处理, 走本地).
//     严格意义上配置错就该报错, 但 PATCH 校验已经挡住坏 JSON (validateRunnerEntry
//     + assertRunnerIdsExist); 这里只是双保险.
//   - registry 注入: registry 接口(找 connection)由 caller 传入, 保持纯函数.
//     canUseTool 直接调 listOnlineConnections(); 测试时 mock.
//   - α os_type 过滤 (damo 0829): entry 可选 os_type 字段; 候选 connection
//     必须有至少一条 matched entry 满足「entry.os_type 未设 (向后兼容不限)
//     或 entry.os_type === connection.runner.os_type」. 即多 OS 项目里每条
//     entry 自己声明目标 OS (e.g. Tauri mac shell + Tauri windows build),
//     白名单按 OS 互斥配 (同一 pattern 不同时挂在 mac + windows entry).

import {
  listOnlineConnections,
  _listAllConnections,
} from "./registry";
import type { ProjectRunnersConfig } from "../db/projects";
import type {
  ProjectRunnerEntry,
} from "../db/projects";
import type { RouteResolution, RunnerConnection } from "./types";

// 路由函数签名暴露给测试注入, 上线调用走默认参数.
// 'allConnections' 是"任意 status 的 runner 集合", 我们内部拿它做
//   "有候选但全 offline" 判断. 'onlineConnections' 是 status==='online' 的
//   子集, 我们取字典序第一个.
export interface RoutingLookups {
  allConnections?: () => RunnerConnection[];
  onlineConnections?: () => RunnerConnection[];
}

/**
 * 决定一条 Bash 命令是否应走 runner.
 *
 * @param project - 当前 task 的 project 行 (来自 getProjectById). 传 null 表示
 *   没有 project (e.g. system tasks), 直接返 null (走本地).
 * @param command - agent 传给 Bash 的命令串.
 * @param lookups - 注入 registry 函数 (测试用). 默认 = 模块级 listOnlineConnections.
 * @returns 见 RouteResolution 类型.
 */
export function resolveRunnerRoute(
  project: { runners?: string | null } | null | undefined,
  command: string,
  lookups: RoutingLookups = {},
): RouteResolution {
  // 1. project 缺失 / runners 列空 → 没有配置 → null (走本地).
  if (!project || !project.runners) return null;
  const json = project.runners;
  let entries: ProjectRunnersConfig;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    entries = parsed as ProjectRunnersConfig;
  } catch {
    // 配置 JSON 损坏. PATCH 校验已挡过; 这里守最后一道. 走本地比 deny 安全.
    return null;
  }
  if (entries.length === 0) return null;

  // 2. 按 command 找白名单命中. 任意一条 entry.command_patterns 命中即可.
  //   命中即记 entry 为候选 (后续从 entry 里拿 runner_id + cwd_mapping).
  const matched: ProjectRunnerEntry[] = [];
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.command_patterns)) continue;
    if (!entry.command_patterns.length) continue;
    if (matchesAnyPattern(command, entry.command_patterns)) {
      matched.push(entry);
    }
  }
  if (matched.length === 0) return null;

  // 3. 候选 entry 的 runner_id 都拿对应 connection, 排除 status !== 'online'.
  //   "online" 这个判定由 listOnlineConnections() 在 registry 里集中做.
  const allConnections = lookups.allConnections ?? _listAllConnections;
  const onlineConnections =
    lookups.onlineConnections ?? listOnlineConnections;
  const online = onlineConnections();
  // 为字典序取第一个, 我们需要一个稳定集合. online() 已 stable (Map.values()),
  //   但跨机器可能顺序不同 (Map 插入序). 这里现 sort.
  const sortedOnline = [...online].sort((a, b) =>
    a.runner.id < b.runner.id ? -1 : a.runner.id > b.runner.id ? 1 : 0,
  );

  // 收集候选 runner_id (去重) —— 用于 deny 文案显示 candidate 集合
  const candidateIds = new Set<string>();
  for (const e of matched) candidateIds.add(e.runner_id);

  // 在 sortedOnline 里挑第一个属于候选集合的. α: 该 runner 至少有一条 matched entry
  //   满足 os_type 兼容 (entry.os_type 未设或与 runner.os_type 相同). 多 OS 项目里
  //   若 pattern 同时挂了 mac + windows entry, routing 按 entry.runner_id 字典序选
  //   第一个 os_type 匹配的 —— 等价于"白名单按 OS 互斥"的实现层表达.
  const chosen = sortedOnline.find((c) => {
    if (!candidateIds.has(c.runner.id)) return false;
    const entriesForThisRunner = matched.filter(
      (e) => e.runner_id === c.runner.id,
    );
    return entriesForThisRunner.some(
      (e) => !e.os_type || e.os_type === c.runner.os_type,
    );
  });
  if (chosen) {
    // 拿对应 entry 的 cwd_mapping. 一个 runner_id 可能挂在多条 entry 下
    //   (e.g. 不同 purpose). 取第一条 os_type 兼容的 (与上面的 find 对齐).
    const entry = matched.find(
      (e) =>
        e.runner_id === chosen.runner.id &&
        (!e.os_type || e.os_type === chosen.runner.os_type),
    )!;
    return {
      runner: chosen,
      cwdMapping: entry.cwd_mapping,
    };
  }

  // 4. 有白名单命中 + 候选集合非空 + 没有 online runner → deny.
  //   检查 candidates 中是否有"存在但 offline/dead" — 决定 reason 文案.
  const all = allConnections();
  const allById = new Map(all.map((c) => [c.runner.id, c]));
  const anyExisting = Array.from(candidateIds).some((id) => allById.has(id));
  if (anyExisting) {
    // 候选 runner 都存在但 offline/dead.
    return {
      runner: null,
      reason: `runner offline (candidates: ${Array.from(candidateIds).join(", ")})`,
    };
  }
  // 候选 runner_id 在 registry 里一个都没有 — 配置指了不存在的 runner.
  //   这种配置错走 deny (operator 一眼能看出), 不 fallback 到本地 (防绕过审计).
  return {
    runner: null,
    reason: `runner offline (candidates not registered: ${Array.from(candidateIds).join(", ")})`,
  };
}

// 功能: 给定一条命令串和一组 pattern, 判断是否命中.
//   规则: pattern 是 "escape + .*" 后作为正则. 即 pattern="echo" 等价
//   /^.*echo.*/ — 命令里出现子串即命中 ("前缀包含" 的扩展版).
//   这个语义由 rollout §5 R3 / docs/plans/runners.md 拍板, MVP 不要
//   强制用户写正则.
// 关注点:
//   - 性能: 单条命令 vs 一组 pattern 是 N 次正则, N 上限 32 (projects.ts
//     MAX_COMMAND_PATTERNS). 实际白名单通常 < 10, 不做缓存.
//   - escape: pattern 里的所有 regex meta 必须 escape; 否则用户写
//     "cargo.tauri.build" 这种含 . 的会被当作正则 = 误匹配.
//   - 空 pattern: 命令永远命中 ("")? 不, 空 pattern 不应算命中 (视为
//     配置错). 见 checkEmptyOrInvalidPattern 的处理.
//   - 大小写敏感: Bash 命令大小写敏感 ("Echo" 不等于 "echo"); 不做 i 标志
//     (CLI 工具名都小写, 不需要).
function matchesAnyPattern(command: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (!p || typeof p !== "string") continue;
    const re = patternToRegExp(p);
    if (re.test(command)) return true;
  }
  return false;
}

// 功能: "escape + .*" 拼成前缀包含正则.
//   pattern = "cargo tauri build"  → /^.*cargo tauri build.*/
//   pattern = "echo"               → /^.*echo.*/
//   pattern = "npm.cmd"            → /^.*npm\.cmd.*/  (. 被 escape)
// 关注点:
//   - 我们用 .test() 不需要 ^ 锚定 (因为 .* 已经包了), 但 ^.* 仍是
//     显式锚定 = 性能好一丁点, 防止假匹配 (regex 起始位置 = 0).
//   - 不做 ^pattern$ 严格匹配 — 白名单语义是 "前缀包含", 用户写 "cargo build"
//     应该匹配 "cargo build --release".
export function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^.*${escaped}.*`);
}