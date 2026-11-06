// Project CRUD — see src/lib/db/index.ts for DB initialization

import path from "node:path";
import fs from "node:fs";
import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import { DELETED_TAG, ORCHESTRATOR_HOME } from "../constants";
import { parseStrArray } from "../json-array";
import { normalizeExtensionsInput } from "../wiki-files";
import {
  parseTimeoutMinutes,
  MIN_TASK_TIMEOUT_MINUTES,
  MAX_TASK_TIMEOUT_MINUTES,
  getPortPool,
  isPortInPool,
  MAX_PORTS_PER_PROJECT,
} from "./settings";
import { PortPoolConflictError, type PortConflict } from "./port-pool-error";

// Runners 配置: 每条 entry 把平台 agent 跑命令时引到一个注册的 runner 上.
//   runner_id         : 必须真存在于 runners 表 (FK 校验在应用层做, 见下方)
//   purpose           : 自由文本, admin 自己解释为什么配这条 (例如 "mac-tauri-build")
//   cwd_mapping       : 平台 cwd 是 WSL 路径 (/home/user/...), runner 是物理机
//                       路径 (/Users/user/...). 不映射直接 exec 必失败.
//                       **必填** —— PATCH 校验里 throw, 路由层 catch 回 400.
//   command_patterns  : 子串匹配 (R3 路由函数 escape 后 .*); 上限 32 条防滥用.
//   os_type           : (α, damo 0829 拍板) 可选. 这条白名单的目标 OS.
//                       路由阶段会校验 entry.os_type 与 runner.connection.os_type
//                       严格匹配 —— 多 OS 项目 (e.g. Tauri mac + windows) 里每条
//                       entry 各自声明 OS, routing 按 entry.runner_id 字典序选
//                       第一个匹配的 candidate.
//                       不传 = 向后兼容, 视为不限 OS (旧 entry 仍按现有行为).
export const MAX_COMMAND_PATTERNS = 32;

export interface ProjectRunnerEntry {
  runner_id: string;
  purpose: string;
  cwd_mapping: string;
  command_patterns: string[];
  os_type?: "macos" | "windows" | "linux";
}

export type ProjectRunnersConfig = ProjectRunnerEntry[];

// 校验一条 entry. 失败抛带具体原因; 路由层把 message 透传给前端 (PATCH 已经
// 设计成 throw -> 400, 沿用 wiki_extra_extensions 的同一种 pattern).
function validateRunnerEntry(
  entry: unknown,
  index: number
): asserts entry is ProjectRunnerEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error(`runners[${index}] 必须是对象`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.runner_id !== "string" || !e.runner_id) {
    throw new Error(`runners[${index}].runner_id 必须是非空字符串`);
  }
  if (typeof e.purpose !== "string" || !e.purpose.trim()) {
    throw new Error(`runners[${index}].purpose 必须是非空字符串`);
  }
  if (typeof e.cwd_mapping !== "string" || !e.cwd_mapping.trim()) {
    throw new Error(`runners[${index}].cwd_mapping 必须是非空字符串`);
  }
  if (!Array.isArray(e.command_patterns)) {
    throw new Error(`runners[${index}].command_patterns 必须是 string[]`);
  }
  if (e.command_patterns.length > MAX_COMMAND_PATTERNS) {
    throw new Error(
      `runners[${index}].command_patterns 最多 ${MAX_COMMAND_PATTERNS} 条, 当前 ${e.command_patterns.length}`
    );
  }
  for (let i = 0; i < e.command_patterns.length; i++) {
    const p = e.command_patterns[i];
    if (typeof p !== "string") {
      throw new Error(
        `runners[${index}].command_patterns[${i}] 必须是字符串`
      );
    }
  }
  // α (damo 0829): os_type 可选. 设了的话必须是枚举之一; 不传 = 不限 (向后兼容).
  if (e.os_type !== undefined && e.os_type !== null) {
    if (e.os_type !== "macos" && e.os_type !== "windows" && e.os_type !== "linux") {
      throw new Error(
        `runners[${index}].os_type 必须是 macos/windows/linux 之一, 收到 ${String(e.os_type)}`
      );
    }
  }
}

// 应用层 FK: 每个 runner_id 必须真在 runners 表里. 这里 SELECT 一次, 给
// 详细错误信息 (哪个 id 找不到). 比依赖 SQLite FK 灵活, 也避开
// 「ALTER TABLE ADD COLUMN 时不能挂 REFERENCES」的 schema rebuild 痛点.
function assertRunnerIdsExist(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  // 单条 OR-chained IN 比 N 次 SELECT 便宜.
  const placeholders = ids.map(() => "?").join(",");
  const found = db
    .prepare(`SELECT id FROM runners WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string }>;
  const foundSet = new Set(found.map((r) => r.id));
  const missing = ids.filter((id) => !foundSet.has(id));
  if (missing.length > 0) {
    throw new Error(
      `runners 中引用了不存在的 runner_id: ${missing.join(", ")}`
    );
  }
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  current_version_id: string | null;
  current_version_name: string | null; // JOINed from versions table
  cwd: string | null;
  owner_id: string | null; // FK users.id (T2); NULL = pre-auth legacy row
  pinned: number; // 0/1; listProjects always orders pinned first
  deleted_at: string | null; // v33 soft-delete; NULL = live
  // v35 wiki 高级选项: 额外放行的文件扩展名, JSON 数组串如 '["json","csv"]'。
  // '[]' / NULL = 只放行 .md (默认, 与本特性上线前一致)。解析走 wiki-files.ts
  // 的 parseStoredExtensions —— 别直接 JSON.parse, 那样绕过白名单校验。
  wiki_extra_extensions: string | null;
  // v38: 本项目共享同一个 cwd 的任务可同时跑几个。1/NULL = 同 cwd 串行(默认)。
  // 判据在 TaskScheduler.cwdLimit() —— 只放宽 per-cwd 互斥, 全局并发和
  // per-owner 上限照旧。
  parallel_limit: number | null;
  // v40: 本项目任务的壁钟超时(分钟)。NULL = 继承全局默认
  // (app_settings.task_timeout_minutes, 缺省 30)。解析在 agent-runtime 的
  // resolveTaskTimeoutMs()。
  timeout_minutes: number | null;
  // v51: 本项目允许使用的 runner + 白名单命令 + 路径映射. JSON 数组字符串,
  // 结构见 ProjectRunnersConfig; NULL = 不走任何 runner, 全部本地执行.
  // 解析在 routing.ts (R3 阶段加), 这里只管入库 + 校验.
  runners: string | null;
  // v54: 本项目占用的端口列表 (R18 飞书 R19 端口自动化分配).
  // JSON 数组字符串 (如 '[13001,13002]'), NULL = 未分配. 解析走 parsePorts,
  // 写入前必须经 normalizePorts 校验 (1024-65535, 最多 5 个, 去重).
  ports: string | null;
  // v58: 项目导航手动排序值 (飞书 R28). 用户拖拽后由前端批量 set (步长 1000),
  // NULL = 未排过, listProjects(sort="manual") 兜底到 created_at DESC. 同值不
  // 报错 (DB 不加 UNIQUE), 创建后默认 NULL —— 已存在项目不会自动赋 sort_order,
  // 保持旧排序行为直到用户第一次拖动。
  sort_order: number | null;
  // DAG P2 (v71): 项目级拓扑调度开关. 0/1 (SQLite boolean). 默认 0 = 与现状
  // byte-identical (B1 拍板); 1 = TaskScheduler.schedule() 尊重 depends_on,
  // 未满足依赖的 task 留 queued. 项目级而非全局 = 保护 M 模式「depends_on
  // 不挡调度器」拍板 (M 依赖是后写入的). 读路径走 getProjectDagEnforced().
  dag_enforced: number;
  // DAG P3 (v72): 机械验收门 (Prove2Me 借鉴). 三字段都默认开=不启用
  //   (byte-identical 行为), 配合 L1 平台级 master switch
  //   (app_settings.verification_globally_enabled, B5 拍板默认 false) 双重防御.
  //   关一即停. 设计稿 docs/plans/dag-verification.md §4.3 / §6.
  //   - verification_command: null = 不开 (与今天 byte-identical). 非 null =
  //     agent SDK 报完成后翻 verifying → 跑命令 → 成功翻 completed / 失败回退
  //     running + 注入反馈. 命令语义由项目 owner 自己负责 (平台不做 shell escape).
  //   - verification_timeout_seconds: 命令超时秒数. 默认 600 (10min). 范围 10-3600.
  //   - verification_max_retries: 验收失败重试次数 (B3 拍板 = 2). 总尝试 = N+1
  //     (首次 + N 次重试). 0 = 失败一次直接 failed. 范围 0-5.
  verification_command: string | null;
  verification_timeout_seconds: number;
  verification_max_retries: number;
  // v532 (侧栏项目右键操作): starred 1 = 收藏 (listProjects 排 pinned 之后的
  // 第二优先段; 不变量 pin ⇒ star, pin 动作联动附带收藏, 取消收藏联动取消置顶).
  starred: number;
  // v532: archived 1 = 归档 —— listProjects 默认过滤掉 (侧栏/项目列表不显示,
  // 数据不动, 仍可经 URL 访问), 归档列表走 listProjects(opts.archived).
  // 与 deleted_at (级联软删, 一切视图消失) 构成三档生命周期: 活跃→归档→删除.
  archived: number;
}

// parallel_limit 上限, 与 PATCH /api/config 的 concurrency 边界对齐 —— 全局并发
// 都到不了 10, 单项目再高没有意义。
export const MAX_PARALLEL_LIMIT = 10;

// Sort key for listProjects. recent_activity = MAX(tasks.updated_at),
// falling back to projects.created_at so brand-new projects don't sort
// to the bottom behind projects that have never been touched.
// manual = 按 sort_order 升序, NULL 行兜底回 created_at DESC (飞书 R28).
export type ProjectSort = "created_at" | "recent_activity" | "manual";

export interface CreateProjectInput {
  name: string;
  description?: string;
  cwd?: string;
  ownerId?: string; // from session (x-user-id); API routes always set this
  // v54: ports —— 项目级端口列表 (number[]). 传入 undefined = 不分配;
  // 空数组 [] = 显式分配空 (罕见但合法). 详见 normalizePorts.
  ports?: number[];
}

// v54: 把任意 ports 输入规范化成合法的 number[] —— R18.
// 规则 (damo 飞书 R19): "1~3 个居多, 允许最多 5 个" + 1024-65535 + 去重.
// 关注点:
//  - 入参可以是 string (逗号分隔 "13001, 13002") / number[] / undefined / null.
//   null/undefined → 返回 null (= 不分配, 写入 NULL).
//   非空数组 → 走 normalize: 校验每一项是 1024-65535 整数, 去重, 最多 5 个.
//  - 非法项抛错 (含信息), 调用方 catch 后给 400.
//  - 留 NOT NULL 的兜底: caller 没传 ports → 不写 ports 列 (DB 默认 NULL).
//  - R18 P2: 池 + 冲突校验拆到 createProject / updateProject 里走 (需要拿到
//    「其它项目已用端口集合」+「自己当前端口」才能算冲突), 这里只验单条边界.
export function normalizePorts(input: unknown): number[] | null {
  if (input === undefined || input === null) return null;

  let arr: unknown[];
  if (typeof input === "string") {
    arr = input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(input)) {
    arr = input;
  } else {
    throw new Error(`ports 必须是数组或逗号分隔字符串, 收到 ${typeof input}`);
  }

  if (arr.length === 0) return null; // 空数组 → 视为未分配
  if (arr.length > MAX_PORTS_PER_PROJECT) {
    throw new Error(
      `ports 最多 ${MAX_PORTS_PER_PROJECT} 个, 收到 ${arr.length} 个`,
    );
  }

  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of arr) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      throw new Error(`ports 每一项必须是 1024-65535 整数, 收到 ${String(item)}`);
    }
    if (seen.has(n)) {
      // 重复: 静默去重, 不抛错 —— 用户可能填了两个 13001 期望都通过.
    } else {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// DAG P3: 机械验收门字段边界. 与 settings.ts 的 parseTimeoutMinutes 等
// 整数字段边界校验同套路 (非法抛错 → PATCH 路由回 400).
// timeout 范围 [10, 3600] (10s - 1h): 下限避免「刚启动就被 kill」, 上限避免
// 一次验收堵调度器过久 (任务排队过长, 调度器视为在飞任务).
export const MIN_VERIFICATION_TIMEOUT_SECONDS = 10;
export const MAX_VERIFICATION_TIMEOUT_SECONDS = 3600;
export const DEFAULT_VERIFICATION_TIMEOUT_SECONDS = 600;
export const MIN_VERIFICATION_MAX_RETRIES = 0;
export const MAX_VERIFICATION_MAX_RETRIES = 5;
export const DEFAULT_VERIFICATION_MAX_RETRIES = 2;

// 功能: 校验 verification_timeout_seconds. 合法返整数, 非法返 null.
// 关注点: setter / updateProject 共用, 保证校验口径一致 (同 parseTimeoutMinutes).
export function parseVerificationTimeoutSeconds(input: unknown): number | null {
  const n = Number(input);
  if (!Number.isInteger(n)) return null;
  if (n < MIN_VERIFICATION_TIMEOUT_SECONDS || n > MAX_VERIFICATION_TIMEOUT_SECONDS) return null;
  return n;
}

// 功能: 校验 verification_max_retries. 合法返整数, 非法返 null.
export function parseVerificationMaxRetries(input: unknown): number | null {
  const n = Number(input);
  if (!Number.isInteger(n)) return null;
  if (n < MIN_VERIFICATION_MAX_RETRIES || n > MAX_VERIFICATION_MAX_RETRIES) return null;
  return n;
}

// 功能: 读项目级 verification_command / timeout / max_retries, 把 DB 兜底值
//   (ALTER ADD DEFAULT 给的) 规范成类型安全的字段.
// 关注点: getProjectById 返回 Project 的 verification_* 字段类型上 required,
//   但旧行 ALTER 之前创建的如果有 NULL (理论上不会, ALTER 加了 DEFAULT) 也
//   兜底到 DEFAULT. 与 timeout_minutes 解析路径同模式.
export function getProjectVerificationConfig(project: Project): {
  command: string | null;
  timeoutSeconds: number;
  maxRetries: number;
} {
  return {
    command: project.verification_command,
    timeoutSeconds:
      project.verification_timeout_seconds ?? DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
    maxRetries:
      project.verification_max_retries ?? DEFAULT_VERIFICATION_MAX_RETRIES,
  };
}

// v54 P2 (R18): 收集「所有项目已用端口」集合, 排除 excludeProjectId (更新自己
// 时不算自己). 软删项目 (deleted_at IS NULL) 仍然算占用 —— 软删只是 UI 不显示,
// 端口不能立刻释放, 否则同端口被另一个项目接管, 旧项目恢复时撞车.
// 关注点:
//  - 单条 SQL 比应用层循环 SELECT 快; ports 是 JSON 数组字符串, SQLite 没原生
//   JSON 表函数就用 json_each 拆. 旧库可能写入过 NULL 或非 JSON, 用 json_valid
//   守一下, 非法行跳过 (不抛 — 旧脏数据不该让端口列表接口挂掉).
export function listUsedPorts(excludeProjectId?: string): Set<number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, ports FROM projects
       WHERE deleted_at IS NULL AND ports IS NOT NULL AND ports != ''
       ${excludeProjectId ? "AND id != ?" : ""}`,
    )
    .all(...(excludeProjectId ? [excludeProjectId] : [])) as Array<{
    id: string;
    ports: string;
  }>;
  const used = new Set<number>();
  for (const row of rows) {
    try {
      const arr = JSON.parse(row.ports);
      if (Array.isArray(arr)) {
        for (const p of arr) {
          if (Number.isInteger(p)) used.add(p as number);
        }
      }
    } catch {
      // 跳过脏值行.
    }
  }
  return used;
}

// v54 P2 (R18): 校验一组候选端口, 同时检查「在池内」+「不与其它项目冲突」.
// excludeProjectId: 更新自己时传自己的 id, 自己原来的端口不算冲突.
// 关注点:
//  - 返回结构化冲突明细 (outOfPool + conflictingWith [{port, ownerProjectId}])
//    让路由层拼出友好 400 消息, 不用我们自己拼字符串. 字段命名贴近 front-end.
//  - 无冲突返 null —— 调用方只看「null = 通过, 非 null = 拒绝」+ 拒绝原因.
//  - PortConflict 类型在 port-pool-error.ts (与 PortPoolConflictError 一起),
//   这里只 re-export 让 routes/projects 引用方便.
export function checkPortPoolConflict(
  candidatePorts: number[],
  excludeProjectId?: string,
): PortConflict | null {
  const out: PortConflict = { outOfPool: [], conflicting: [] };
  for (const p of candidatePorts) {
    if (!isPortInPool(p)) out.outOfPool.push(p);
  }
  if (out.outOfPool.length > 0) return out;
  // 仅当所有端口都在池内时, 才去查跨项目冲突 (避免无意义的 SQL).
  const used = listUsedPorts(excludeProjectId);
  for (const p of candidatePorts) {
    if (used.has(p)) {
      // 找出谁在用 — 单端口 SQL, 不在循环里跑. 注意: ports 是 JSON 数组,
      // 不能用 = 比较; 走 json_each(?) WHERE value = ? 一对一.
      // json_each 的第一个 ? 是 JSON 字符串 (这里内联进 SQL, 因 candidate 端口
      // 必是 1024-65535 整数, 安全); 第二个 ? 是要查的值.
      const db = getDb();
      const owners = db
        .prepare(
          `SELECT p.id AS id FROM projects p
           WHERE p.deleted_at IS NULL AND p.ports IS NOT NULL AND p.ports != ''
             AND p.id != ? AND EXISTS (
               SELECT 1 FROM json_each(p.ports) je WHERE je.value = ?
             )`,
        )
        .all(excludeProjectId ?? "", p) as Array<{ id: string }>;
      for (const o of owners) {
        out.conflicting.push({ port: p, owner_project_id: o.id });
      }
    }
  }
  if (out.conflicting.length > 0) return out;
  return null;
}

// v54 P2 (R18): 找「池内未占用」的前 n 个端口, 按 [段起点, 段起点+1, ...] 顺序
// 扫 (段内升序). 用于「新建项目表单」自动给一组可用端口, 避免人工从池里翻.
// 关注点:
//  - n=0 返空数组 (异常不抛). n 超过池总容量时只返实际能拿到的 (可能少于 n).
//  - usedPorts 是预取的 used 集合 (调用方从 listUsedPorts() 拿), 避免 N 次
//    listUsedPorts() N+1 查询.
//  - 不去重检查: 池段本身互不重叠 (settings.getPortPool() 校验 start<=end 但
//    不校验段间顺序), 重复入口会拿到同一个端口; 这里靠 caller 传 unique ports.
export function pickAvailablePorts(
  n: number,
  usedPorts: Set<number>,
): number[] {
  if (n <= 0) return [];
  const out: number[] = [];
  const pool = getPortPool();
  for (const [start, end] of pool) {
    for (let p = start; p <= end && out.length < n; p++) {
      if (!usedPorts.has(p)) out.push(p);
    }
    if (out.length >= n) break;
  }
  return out;
}

export function createProject(input: CreateProjectInput): Project {
  const db = getDb();
  const id = uuidv4();
  // R18 P2: 池 + 冲突校验. normalizePorts 已把空/null 归到不分配;
  // 这里在准备写入前再过一次冲突检查, 失败抛带结构的 ConflictError, 路由 catch
  // 后回 409 + conflict 明细 (前端能直接展示).
  if (input.ports && input.ports.length > 0) {
    const conflict = checkPortPoolConflict(input.ports);
    if (conflict) {
      throw new PortPoolConflictError(conflict);
    }
  }
  // ports 写入: 数组 → JSON 字符串; null → NULL 列.
  const portsJson =
    input.ports && input.ports.length > 0 ? JSON.stringify(input.ports) : null;
  // R59: project cwd 默认值. 之前 input.cwd 空时 DB 写 NULL, task 创建走
  // tasks.ts:175 fallback (task > version > project) = 全 null, 任务跑时
  // agent-runtime.ts:1861-1864 才兜底到
  // ~/.agent-orchestrator/projects/<projectId>/<taskId> (任务级独立 cwd,
  // 项目内 task 互相隔离, 不共享工作目录). 现在用户在「新建项目」不填 cwd,
  // 自动落到 $ORCHESTRATOR_HOME/projects/<projectId>/ — 项目级共享 cwd, task
  // 走 project.cwd 命中, 跟 ORCHESTRATOR_HOME/projects/<projectId>/<taskId>
  // 任务级兜底并存 (前者 task.cwd=null 命中, 后者 task.cwd 显式覆盖).
  // ensureUncategorizedProject (line 757) 也调 createProject 不传 cwd, 同
  // 受益 —— 「未分类」项目也会拿到一个默认 cwd.
  const trimmedCwd = input.cwd?.trim();
  const finalCwd = trimmedCwd || path.join(ORCHESTRATOR_HOME, "projects", id);
  // 自动默认时才 mkdir (用户显式传的 cwd = 用户自管, 别擅自建). mkdirSync
  // recursive 幂等, 已存在不报错. 让 task 启动时 cwd 直接存在, 避免
  // "cwd 不存在 SDK 报错" 的二次失败.
  if (!trimmedCwd) {
    try {
      fs.mkdirSync(finalCwd, { recursive: true });
    } catch {
      // 静默失败: 权限不足等 → task 启动时报错, 不阻断项目创建.
    }
  }
  db.prepare(`
    INSERT INTO projects (id, name, description, cwd, owner_id, ports)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.description || null,
    finalCwd,
    input.ownerId ?? null,
    portsJson
  );
  return getProjectById(id)!;
}

// userId is optional: API routes pass it to enforce ownership (non-owner gets
// null -> route returns 404); internal callers (createTask inheriting owner_id,
// validateTaskLocation, updateProject) omit it for an unfiltered read.
// v33: soft-deleted projects are invisible to every caller — a deleted project
// must not accept new tasks, resolve as a task's cwd source, or gate routes.
export function getProjectById(id: string, userId?: string): Project | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.*, v.name as current_version_name
    FROM projects p
    LEFT JOIN versions v ON v.id = p.current_version_id AND v.deleted_at IS NULL
    WHERE p.id = ? AND p.deleted_at IS NULL ${userId ? "AND p.owner_id = ?" : ""}
  `).get(...(userId ? [id, userId] : [id])) as Project | undefined;
  return row ?? null;
}

// DAG P2: 项目级拓扑调度开关 (projects.dag_enforced). true 时
// TaskScheduler.schedule() 把「依赖不满足」当作 skip 判据, false 时与现状
// byte-identical (保护 M 模式「depends_on 不挡调度器」拍板, B1 已拍 false 默认).
// 故意不缓存 —— 仿 cwdLimit(task) 写法 (task-scheduler.ts:161), schedule()
// 触发频率低, 一次主键查询可忽略, 换「改完即生效」, 不必再挂 invalidate 链路.
export function getProjectDagEnforced(projectId: string): boolean {
  return getProjectById(projectId)?.dag_enforced === 1;
}

export function listProjects(
  userId?: string,
  sort: ProjectSort = "created_at",
  // v532: opts.archived=true 查归档列表 (archived=1), 默认 false 只回活跃项目.
  // 归档 ≠ 删除: 归档行数据完整, getProjectById 不过滤 archived (URL 仍可访问).
  opts?: { archived?: boolean },
): Project[] {
  const db = getDb();
  // recent_activity joins MAX(tasks.updated_at) per project; COALESCE keeps
  // task-less projects in a sensible position (newest created_at) instead of
  // dropping to the bottom behind actively-touched older projects.
  // manual (v58): sort_order 升序, NULL 行兜底回 created_at DESC —— 用户拖拽
  // 后才会让项目从 created_at 排序脱钩, 未动过的保持旧行为.
  const orderKey =
    sort === "recent_activity"
      ? "COALESCE(t.last_active, p.created_at) DESC"
      : sort === "manual"
      ? "p.sort_order IS NULL, p.sort_order ASC, p.created_at DESC, p.id ASC"
      : "p.created_at DESC, p.id ASC";
  // v33: the activity subquery must ignore soft-deleted tasks, else a project
  // whose tasks were all deleted keeps sorting by its last pre-deletion touch.
  const joinClause =
    sort === "recent_activity"
      ? `LEFT JOIN (
           SELECT project_id, MAX(updated_at) AS last_active
           FROM tasks
           WHERE project_id IS NOT NULL AND deleted_at IS NULL
           GROUP BY project_id
         ) t ON t.project_id = p.id`
      : "";
  // v532: archived 过滤 (默认只回活跃项目) + starred 排 pinned 之后第二优先段
  // (置顶 → 收藏 → 其余, 收藏的项目浮到未收藏之上但不进置顶段).
  const archivedFilter = opts?.archived ? "p.archived = 1" : "p.archived = 0";
  const sql = userId
    ? `SELECT p.*, v.name as current_version_name
       FROM projects p
       LEFT JOIN versions v ON v.id = p.current_version_id AND v.deleted_at IS NULL
       ${joinClause}
       WHERE p.deleted_at IS NULL AND ${archivedFilter} AND p.owner_id = ?
       ORDER BY p.pinned DESC, p.starred DESC, ${orderKey}`
    : `SELECT p.*, v.name as current_version_name
       FROM projects p
       LEFT JOIN versions v ON v.id = p.current_version_id AND v.deleted_at IS NULL
       ${joinClause}
       WHERE p.deleted_at IS NULL AND ${archivedFilter}
       ORDER BY p.pinned DESC, p.starred DESC, ${orderKey}`;
  return db.prepare(sql).all(...(userId ? [userId] : [])) as Project[];
}

// 功能: 按白名单更新项目字段, 返回更新后的项目.
// 关注点:
//  - 白名单之外的字段被**静默忽略** (PATCH route 直接透传 body). 加新字段时必须
//    在这里登记, 否则接口 200 但值没落库.
//  - wiki_extra_extensions 在这里做校验并**抛错**而不是静默丢弃: 它是安全相关的
//    白名单, 静默丢弃会让用户以为配好了. 调用方(PATCH route)需 catch 成 400.
export function updateProject(
  id: string,
  patch: Partial<Omit<CreateProjectInput, "id">> & {
    current_version_id?: string | null;
    pinned?: number;
    // v532: 收藏 / 归档开关 (0/1). 归档走此入口, 恢复 = archived:0.
    // 不变量 pin ⇒ star 由调用方维护 (置顶时同时传 starred:1), DB 层不强制.
    starred?: number;
    archived?: number;
    // 接受数组或逗号分隔字符串; null/[] = 清空(回到只放行 md).
    wiki_extra_extensions?: string[] | string | null;
    // v38: 同 cwd 并发上限. null = 恢复默认(1, 串行).
    parallel_limit?: number | null;
    // v40: 壁钟超时(分钟). null = 恢复默认(继承全局).
    timeout_minutes?: number | null;
    // v51: project 可用的 runner 配置数组; null = 清空(全部走本地).
    // PATCH /api/projects/[id] 路由直接透传给这里, 校验在这里完成.
    runners?: ProjectRunnersConfig | null;
    // R18 P2: 端口列表. number[] / 逗号分隔 string / null(= 清空回 NULL).
    // createProject 已经走过 normalizePorts, 这里收到的是合法 number[] 或 string,
    // 仍调一次 normalizePorts 兼容 PATCH 路由直接透传 string 的场景.
    ports?: number[] | string | null;
    // v58: 手动排序值. number = 升序位次, null = 清空(回到 created_at 排序).
    // 前端拖拽后批量赋 step (e.g. 0,1000,2000...), 这里只校验整数范围 + 直接
    // 写入 —— 不加 UNIQUE, 同值不报错 (DB 已不挂唯一索引).
    sort_order?: number | null;
    // DAG P3 (v72): 机械验收门. command null = 关; 非空字符串 = 必跑. timeout /
    //   max_retries 整数字段 null = 恢复 DEFAULT (600s / 2 retries).
    verification_command?: string | null;
    verification_timeout_seconds?: number | null;
    verification_max_retries?: number | null;
  }
): Project | null {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) { fields.push("name = ?"); values.push(patch.name); }
  if (patch.description !== undefined) { fields.push("description = ?"); values.push(patch.description); }
  if (patch.cwd !== undefined) { fields.push("cwd = ?"); values.push(patch.cwd); }
  if (patch.current_version_id !== undefined) { fields.push("current_version_id = ?"); values.push(patch.current_version_id); }
  if (patch.pinned !== undefined) { fields.push("pinned = ?"); values.push(patch.pinned); }
  // v532: 收藏/归档开关. 0/1 整数, 非法值静默按 0 处理 (与 pinned 同宽容口径 —
  // 它们是 UI 布尔开关不是安全字段; 真正的越权防护在 route 层 ownership gate).
  if (patch.starred !== undefined) { fields.push("starred = ?"); values.push(patch.starred ? 1 : 0); }
  if (patch.archived !== undefined) { fields.push("archived = ?"); values.push(patch.archived ? 1 : 0); }
  if (patch.wiki_extra_extensions !== undefined) {
    const r = normalizeExtensionsInput(patch.wiki_extra_extensions);
    if (!r.ok) throw new Error(r.error);
    fields.push("wiki_extra_extensions = ?");
    values.push(JSON.stringify(r.value));
  }
  if (patch.parallel_limit !== undefined) {
    // null = 恢复默认(1). 非法值抛错 -> PATCH 路由回 400: 静默写库会让用户以为
    // 调高了并发, 而调度器仍按 1 串行, 排查起来很贵.
    const n = patch.parallel_limit === null ? 1 : Number(patch.parallel_limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL_LIMIT) {
      throw new Error(`parallel_limit 必须是 1-${MAX_PARALLEL_LIMIT} 的整数`);
    }
    fields.push("parallel_limit = ?");
    values.push(n);
  }
  if (patch.timeout_minutes !== undefined) {
    // null = 清空 -> 继承全局默认. 非法值抛错 -> PATCH 路由回 400(同 parallel_limit
    // 的理由: 静默写库会让人以为超时调长了, 而任务照旧 30min 被挂起).
    if (patch.timeout_minutes === null) {
      fields.push("timeout_minutes = NULL");
    } else {
      const n = parseTimeoutMinutes(patch.timeout_minutes);
      if (n === null) {
        throw new Error(
          `timeout_minutes 必须是 ${MIN_TASK_TIMEOUT_MINUTES}-${MAX_TASK_TIMEOUT_MINUTES} 的整数`
        );
      }
      fields.push("timeout_minutes = ?");
      values.push(n);
    }
  }
  if (patch.runners !== undefined) {
    // v51: project 级 runner 配置. 校验全部在这里 -> PATCH 路由 catch throw
    // 回 400 + message(同 wiki_extra_extensions / parallel_limit 模式).
    //
    // 关注点:
    //  - null = 清空, 落到 SQLite NULL 表示「不走任何 runner」. 这是显式置空,
    //    跟 timeout_minutes:null 的语义一致(null ≠ 未传).
    //  - json 序列化失败(循环引用 等)理论上不会发生 (对象结构固定), 但
    //    JSON.stringify 抛错时透传给 400, 比静默断更好排查.
    //  - duplicate runner_id 是被允许的(每条 entry 独立 agent 路由判定,
    //    R3 routing.ts dedupe). 这里**不**做去重校验.
    if (patch.runners === null) {
      fields.push("runners = NULL");
    } else {
      if (!Array.isArray(patch.runners)) {
        throw new Error(`runners 必须是数组或 null`);
      }
      const entries = patch.runners as unknown[];
      for (let i = 0; i < entries.length; i++) {
        validateRunnerEntry(entries[i], i);
      }
      const ids = (entries as ProjectRunnerEntry[]).map((e) => e.runner_id);
      assertRunnerIdsExist(ids);
      fields.push("runners = ?");
      values.push(JSON.stringify(entries));
    }
  }
  if (patch.ports !== undefined) {
    // R18 P2: 端口更新. null = 清空(回 NULL 列); 非空 = 走 normalizePorts 校验
    // + 池 + 跨项目冲突. 冲突抛 PortPoolConflictError (带 code=status=409), PATCH
    // 路由 catch 后回 409 + 结构化 conflict. 排除自己 (excludeProjectId=id) —
    // 自己原占的端口不算冲突, 否则改端口时永过不了.
    let normalized: number[] | null;
    try {
      normalized = normalizePorts(patch.ports);
    } catch (err) {
      throw new Error((err as Error).message);
    }
    if (normalized && normalized.length > 0) {
      const conflict = checkPortPoolConflict(normalized, id);
      if (conflict) {
        throw new PortPoolConflictError(conflict);
      }
      fields.push("ports = ?");
      values.push(JSON.stringify(normalized));
    } else {
      // [] / null / 空串 = 显式清空.
      fields.push("ports = NULL");
    }
  }
  if (patch.sort_order !== undefined) {
    // v58: 手动排序值. null = 清空 (回兜底排序); number = 必须是 32-bit 有符号
    // 整数, 范围 [-2_147_483_648, 2_147_483_647] 以防前端误传负数或浮点. 非法值
    // 抛错 -> PATCH 路由回 400, 与 timeout_minutes 同模式 (静默写库会让 UI 显示
    // 顺序混乱, 排查很贵).
    if (patch.sort_order === null) {
      fields.push("sort_order = NULL");
    } else {
      if (!Number.isInteger(patch.sort_order)) {
        throw new Error(`sort_order 必须是整数, 收到 ${patch.sort_order}`);
      }
      fields.push("sort_order = ?");
      values.push(patch.sort_order);
    }
  }
  if (patch.verification_command !== undefined) {
    // DAG P3: null = 关 (与今天 byte-identical 行为); 非空字符串 = 必跑. 平台
    //   不做 shell escape —— 命令语义由项目 owner 自己负责 (含特殊字符).
    //   空字符串视为 null (与 timeout_minutes null = 恢复默认同语义: 显式清空
    //   比留空字符串更不容易误踩). 抛错 -> 400 (同其它校验模式).
    if (patch.verification_command === null || patch.verification_command === "") {
      fields.push("verification_command = NULL");
    } else if (typeof patch.verification_command !== "string") {
      throw new Error(`verification_command 必须是字符串或 null`);
    } else {
      fields.push("verification_command = ?");
      values.push(patch.verification_command);
    }
  }
  if (patch.verification_timeout_seconds !== undefined) {
    if (patch.verification_timeout_seconds === null) {
      fields.push("verification_timeout_seconds = NULL");
    } else {
      const n = parseVerificationTimeoutSeconds(patch.verification_timeout_seconds);
      if (n === null) {
        throw new Error(
          `verification_timeout_seconds 必须是 ${MIN_VERIFICATION_TIMEOUT_SECONDS}-${MAX_VERIFICATION_TIMEOUT_SECONDS} 的整数`,
        );
      }
      fields.push("verification_timeout_seconds = ?");
      values.push(n);
    }
  }
  if (patch.verification_max_retries !== undefined) {
    if (patch.verification_max_retries === null) {
      fields.push("verification_max_retries = NULL");
    } else {
      const n = parseVerificationMaxRetries(patch.verification_max_retries);
      if (n === null) {
        throw new Error(
          `verification_max_retries 必须是 ${MIN_VERIFICATION_MAX_RETRIES}-${MAX_VERIFICATION_MAX_RETRIES} 的整数`,
        );
      }
      fields.push("verification_max_retries = ?");
      values.push(n);
    }
  }
  if (fields.length === 0) return getProjectById(id);
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getProjectById(id);
}

// 功能: 级联软删一个项目 —— 项目自己 + 其下所有 version + 所有 task 都打上
// deleted_at, 从各列表消失但数据全留, 可手工 SQL 恢复. 返回软删掉的 task 数.
// 关注点:
//  - 为什么不硬删: tasks.project_id / version_id 没有 ON DELETE 子句, 而
//    foreign_keys=ON, 裸 DELETE 对任何有 task 的项目都 FK 失败(就是本次修的
//    500). 且 task 本身是软删可恢复的(有 restore 入口 + uploads/ 附件文件),
//    硬删会毁数据.
//  - task 的软删语义必须和 deleteTask() 完全一致: deleted_at + tags 里加
//    DELETED_TAG. 只写 deleted_at 会让这里产生的行和 deleteTask 产生的行不一
//    致(UI 靠 tag 显示「已删除」标记, restore 靠移除 tag 还原).
//  - 整个操作包在一个事务里: 半途失败不会留下「项目没删但 task 全删了」的中间态.
//  - 不做 restoreProject: 本次不加恢复入口(YAGNI), 数据留着够手工恢复即可.
export function deleteProject(id: string): { versions: number; tasks: number } {
  const db = getDb();
  const now = "datetime('now')";

  const run = db.transaction(() => {
    // 逐行读 tags 再回写 —— 无法用一条 UPDATE 完成, 因为 DELETED_TAG 要合并进
    // 已有的 JSON 数组而不是覆盖.
    const liveTasks = db
      .prepare(
        `SELECT id, tags FROM tasks WHERE project_id = ? AND deleted_at IS NULL`
      )
      .all(id) as Array<{ id: string; tags: string | null }>;
    const tagTask = db.prepare(
      `UPDATE tasks SET deleted_at = ${now}, tags = ?, updated_at = ${now} WHERE id = ?`
    );
    for (const t of liveTasks) {
      const tags = parseStrArray(t.tags);
      if (!tags.includes(DELETED_TAG)) tags.push(DELETED_TAG);
      tagTask.run(JSON.stringify(tags), t.id);
    }

    // idea-canvas v521 级联 (damo 1012: 任务删除自动从分类去掉): 项目删除时,
    //   被软删任务在分类列表里的条目一并清理 (弱引用, 不影响列表本体).
    db.prepare(
      `DELETE FROM pin_list_items WHERE ref_type = 'task'
       AND ref_id IN (SELECT id FROM tasks WHERE project_id = ?)`
    ).run(id);

    const versions = db
      .prepare(
        `UPDATE versions SET deleted_at = ${now} WHERE project_id = ? AND deleted_at IS NULL`
      )
      .run(id).changes;

    db.prepare(
      `UPDATE projects SET deleted_at = ${now} WHERE id = ? AND deleted_at IS NULL`
    ).run(id);

    return { versions, tasks: liveTasks.length };
  });

  return run();
}

/** Name of the per-user default project every user starts with (T4). */
export const UNCATEGORIZED_NAME = "未分类";

/**
 * Ensure the given user owns a "未分类" project. Called at registration so every
 * user starts with one (Phase 1 T4). Idempotent: returns the existing one if the
 * user already has one. Reclaims the pre-auth global "未分类" (owner_id NULL,
 * created by migration v7 before any user registered) for the first user,
 * matching the T4 NULL-owner decision "无 admin 则置为首个注册用户".
 *
 * v33 关注点: 这里的 deleted_at IS NULL 过滤是安全的, **不需要**复活软删行.
 * 表级 UNIQUE(owner_id, name) 已被换成 partial unique index
 * (uq_projects_live ... WHERE deleted_at IS NULL), 所以软删掉的「未分类」不再
 * 占用名字, 走到末尾的 createProject 不会撞 UNIQUE —— 用户软删了「未分类」之后
 * 会拿到一个全新的空「未分类」, 旧的那个连同它的 task 仍在库里可手工恢复.
 * (若哪天把 partial index 改回表级 UNIQUE, 这里会立刻变成 UNIQUE 冲突报错.)
 */
export function ensureUncategorizedProject(userId: string): Project {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT p.*, v.name as current_version_name
       FROM projects p
       LEFT JOIN versions v ON v.id = p.current_version_id AND v.deleted_at IS NULL
       WHERE p.owner_id = ? AND p.name = ? AND p.deleted_at IS NULL`
    )
    .get(userId, UNCATEGORIZED_NAME) as Project | undefined;
  if (existing) return existing;

  // Claim the orphan global "未分类" (owner_id NULL, from v7) if one still exists.
  const orphan = db
    .prepare(
      `SELECT * FROM projects WHERE name = ? AND owner_id IS NULL AND deleted_at IS NULL LIMIT 1`
    )
    .get(UNCATEGORIZED_NAME) as { id: string } | undefined;
  if (orphan) {
    db.prepare(`UPDATE projects SET owner_id = ? WHERE id = ?`).run(
      userId,
      orphan.id
    );
    return getProjectById(orphan.id)!;
  }

  return createProject({
    name: UNCATEGORIZED_NAME,
    description: "默认未分类项目",
    ownerId: userId,
  });
}
