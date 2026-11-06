// 全局设置（KV 表 app_settings, v39）—— 进程重启不丢的平台级配置。
//
// 与相邻两套配置的分工:
//   app_settings（本文件）  = 全局默认值, 落库, 改一次长期成立
//   projects.<col>          = 项目级覆盖, NULL 表示继承全局
//   代码里的 DEFAULT_*      = 库里没值时的兜底(= 各特性上线前的行为)
//
// 🚫 **不要再引入 ORCHESTRATOR_* 环境变量来配这些值**。曾经有过
// (ORCHESTRATOR_MAX_CONCURRENCY / ORCHESTRATOR_TASK_TIMEOUT_MIN, 2026-08-13 删除):
// 语义只能是「库里没值时的种子」——「更高优先级」会让「UI 改了但 env 还写着旧值」
// 时没人猜得到哪个生效。而种子的价值只覆盖「新实例第一次启动到有人打开设置页」
// 这一小段, 却要求每个读文档的人都记住这条规则, 净收益是负的。新实例要非默认值,
// 起来之后 PATCH 一次即可。
//
// 关注点:
//  - 读取侧一律再校验一遍再返回。库里可能有手工 SQL 写进来的脏值(非数字、0、
//    超大值), 那种情况**降级到默认值**而不是抛错 —— 一个坏设置不该让所有任务起不来。
//  - 读库失败(DB 还没初始化 / 库被锁)同样降级到默认值: 并发上限是在
//    AgentRuntime 构造函数里读的, 那里抛错等于整个 runtime 起不来。

import { getDb } from "./index";

// 任务壁钟超时(分钟)的默认值与边界。
// 30 = 本特性上线前的硬编码值, 也是库里没值时的兜底, 保证不配置时行为完全一致。
// 上限 1440(24h): 再长就不叫超时兜底了; 下限 1 分钟主要给测试和「故意掐短」用。
export const DEFAULT_TASK_TIMEOUT_MINUTES = 30;
export const MIN_TASK_TIMEOUT_MINUTES = 1;
export const MAX_TASK_TIMEOUT_MINUTES = 1440;

// 全局并发上限的默认值与边界。2 = 本设置落库前的缺省值, 也是库里没值时的兜底。
// 上限 10 与 projects.parallel_limit 对齐(MAX_PARALLEL_LIMIT)。
export const DEFAULT_MAX_CONCURRENCY = 2;
export const MIN_MAX_CONCURRENCY = 1;
export const MAX_MAX_CONCURRENCY = 10;

export const KEY_TASK_TIMEOUT_MINUTES = "task_timeout_minutes";
export const KEY_MAX_CONCURRENCY = "max_concurrency";

// 🆕 Goal-driven loop (D19 阶段 2 实施, damo 2026-09-14 拍板):
//   阶段 3 active-session 集成时, gradeGoal() 调 runSingleTurnLlm 时会读这个 key.
//   与通用 summary_model 解耦: 改 summary 配置不会连带影响 goal; Haiku 4.5 廉价稳定,
//   单次评判成本 ≈ $0.001 (input ~500 tok + output ~30 tok).
//   协议: app_settings.goal_grader_model 落库存字符串 (model id), 留空 / 缺值 /
//   非法字符串一律回退到 claude-haiku-4-5-20251001. 与 max_concurrency 的「脏值
//   warn 回退」语义一致.
export const KEY_GOAL_GRADER_MODEL = "goal_grader_model";
export const DEFAULT_GOAL_GRADER_MODEL = "claude-haiku-4-5-20251001";

// 功能: 读 goal grader 模型 id. 链: app_settings.goal_grader_model → DEFAULT_GOAL_GRADER_MODEL.
// 关注点: 空字符串视为「未配置」, 走默认值 (与 setSetting 写「空字符串显式清空」语义不同
//   —— getSetting 拿到空串仍然返空串, 这里再 trim 一次当作「未配」).
export function getGoalGraderModel(): string {
  const raw = getSetting(KEY_GOAL_GRADER_MODEL);
  if (raw !== null && raw.trim() !== "") return raw.trim();
  return DEFAULT_GOAL_GRADER_MODEL;
}

// 🆕 Goal-driven loop 阶段 4 (D21, damo 2026-09-14 拍板): goal loop 最长跑几轮.
//   默认 20 (R143 二轮, damo 2026-09-15 拍板改自 5): 给足余量, 复杂多步任务不必
//   再手动调.
//   R143 四轮 (damo 2026-09-15 拍板): 范围扩到 [0, 1000] — 0 是 sentinel 表示
//   「不限制轮次」(continueGoalLoop 见 maxRounds===0 跳过 giveUp), 1000 是
//   兜底上限防止误填巨大数字撑爆 goal_history / 成本失控.
//   阶段 4 续跑决策 (continueGoalLoop) 在 current >= max 时 giveUp, 见 plan §9.4.
//   per-task 覆盖: POST /api/tasks 接 goalRounds 字段, 写入 task.metadata.max_goal_rounds,
//   continueGoalLoop 先读 metadata, 缺省回退到本全局值 (见 agent-runtime.ts:continueGoalLoop).
export const KEY_MAX_GOAL_ROUNDS = "max_goal_rounds";
export const DEFAULT_MAX_GOAL_ROUNDS = 20;
export const MIN_MAX_GOAL_ROUNDS = 0;
export const MAX_MAX_GOAL_ROUNDS = 1000;

// 功能: 读 goal loop 最长轮数. 链: app_settings.max_goal_rounds → 5.
// 关注点: 同 task_timeout_minutes / max_concurrency — 脏值只 warn 并回退.
// 阶段 5 补单测覆盖 0/超范围/NaN/字符串 (D18); 本阶段不写, 见 plan §阶段 5.
export function getMaxGoalRounds(): number {
  return resolveIntSetting({
    key: KEY_MAX_GOAL_ROUNDS,
    min: MIN_MAX_GOAL_ROUNDS,
    max: MAX_MAX_GOAL_ROUNDS,
    fallback: DEFAULT_MAX_GOAL_ROUNDS,
  });
}

// 🆕 Goal-driven loop 阶段 4 (D21): fork vs resume 的 context 阈值.
//   当 context_tokens / context_max >= threshold 时, fork+compactFirst 开新 task;
//   否则 pushMessage 续同一 session. 默认 0.8 与手动 fork 阈值对齐 (plan §2 D3).
//   范围 [0.0, 1.0]: 0.0 = 永远 fork; 1.0 = 永远 resume; 中间值是触发比例.
//   阶段 5 补边界单测 (D18); 本阶段只实现读取 + 兜底回退.
export const KEY_GOAL_RESUME_THRESHOLD = "goal_resume_threshold";
export const DEFAULT_GOAL_RESUME_THRESHOLD = 0.8;
export const MIN_GOAL_RESUME_THRESHOLD = 0.0;
export const MAX_GOAL_RESUME_THRESHOLD = 1.0;

// 功能: 读 goal loop context 阈值. 链: app_settings.goal_resume_threshold → 0.8.
// 关注点: 边界 0.0 / 1.0 都合法 (= 永远 fork / 永远 resume), 用 parseFloatInRange
//   已覆盖. 脏值 (NaN / Infinity / 字符串 / 超范围) warn 并回退.
export function getGoalResumeThreshold(): number {
  return resolveFloatSetting({
    key: KEY_GOAL_RESUME_THRESHOLD,
    min: MIN_GOAL_RESUME_THRESHOLD,
    max: MAX_GOAL_RESUME_THRESHOLD,
    fallback: DEFAULT_GOAL_RESUME_THRESHOLD,
  });
}

// 🆕 DAG P3 (B5 拍板 2026-09-06): 平台级 master switch. 默认 false —— 与今天
//   byte-identical 行为. true 时进入项目级判据 (读 projects.verification_command).
//   双重防御: L1 关 或 L2 项目级 command=null 都直接走老路径 (agent SDK 报完成
//   → 翻 completed, 不进入 verifying). 一键 kill 不需遍历项目.
//   协议: 'true' / '1' = 开; 其他 (缺值/'false'/'0'/null) = 关.
//   写入走 PATCH /api/config 入口 (现有 KV 操作路径, 不需 migration).
export const KEY_VERIFICATION_GLOBALLY_ENABLED = "verification_globally_enabled";

// 🆕 飞书 R79: schedule_runs 清理阈值（全局默认, schedule 维度不另设覆盖）。
//   两个一起决定 purgeOldRuns 行为:
//     schedule_runs_ttl_days: 早于 N 天的 runs 整表删 (默认 30, 0 = 不按年龄清理)
//     schedule_runs_keep_last_n: 每 schedule 保留最新 N 条 (默认 100, 0 = 不按数量清理)
//   边界: 1-3650 (10 年) 防呆; 与 schedule_timeout_minutes 同样的「脏值 warn 回退」语义。
export const DEFAULT_SCHEDULE_RUNS_TTL_DAYS = 30;
export const MIN_SCHEDULE_RUNS_TTL_DAYS = 0;
export const MAX_SCHEDULE_RUNS_TTL_DAYS = 3650;
export const DEFAULT_SCHEDULE_RUNS_KEEP_LAST_N = 100;
export const MIN_SCHEDULE_RUNS_KEEP_LAST_N = 0;
export const MAX_SCHEDULE_RUNS_KEEP_LAST_N = 100_000;
export const KEY_SCHEDULE_RUNS_TTL_DAYS = "schedule_runs_ttl_days";
export const KEY_SCHEDULE_RUNS_KEEP_LAST_N = "schedule_runs_keep_last_n";

// 端口池 (R18 P2): admin 在平台管理里配置的「可分配给项目的端口段」白名单.
// 格式: JSON 字符串, 值是 [[start,end], [start,end], ...] 的数组, 每段起止 1024-65535.
// 留空 (库里没值) = 无池, 不强制约束, 沿用历史行为(项目端口仅走 1024-65535 边界校验).
export const KEY_PORT_POOL = "port_pool";
// 默认池: ao / ao-dev 两实例历史常用 13000-13099, 留作「库里没值时的兜底」,
// 让默认体验不空. 改这个常量不会改库; 真改 = setPortPool().
export const DEFAULT_PORT_POOL: ReadonlyArray<readonly [number, number]> = [
  [13000, 13099],
];

export type PortPoolRanges = ReadonlyArray<readonly [number, number]>;

// 端口池段边界. 单段起止 1024-65535, 总段数 1-8 (多了 UI 编辑会乱).
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
export const MAX_POOL_SEGMENTS = 8;
// 单项目可分配的端口数上限 (R18 damo 飞书原话: 1~3 个居多, 最多 5).
// normalizePorts / checkPortPoolConflict / pickAvailablePorts / UI 表单都共用这
// 个上限, 避免散在多处口径漂移.
export const MAX_PORTS_PER_PROJECT = 5;

// 功能: 读一个原始设置值, 不存在或读库失败返回 null.
// 关注点: 吞掉读库异常(见文件头) —— 调用方拿 null 会走默认值兜底。
export function getSetting(key: string): string | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch (err) {
    console.warn(`[settings] 读取 ${key} 失败, 走默认值:`, (err as Error).message);
    return null;
  }
}

// 功能: 写一个原始设置值(upsert), 记录改动时间和改动人.
// 关注点: 不做语义校验 —— 校验属于各设置自己的 setter(如 setGlobalTaskTimeoutMinutes),
//   这里只负责存。写失败会抛错(与读不同): 调用方是 API 路由, 必须让用户知道没保存上。
export function setSetting(key: string, value: string, updatedBy?: string | null): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(key, value, updatedBy ?? null);
}

// 功能: 把任意输入校验成 [min,max] 内的整数, 合法返回该整数, 非法返回 null.
function parseIntInRange(input: unknown, min: number, max: number): number | null {
  const n = Number(input);
  if (!Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// 功能: 把任意输入校验成 [min,max] 内的有限浮点数, 合法返回该数, 非法返回 null.
//   关注点: 与 parseIntInRange 对称扩展 — 用 Number(input) + Number.isFinite
//   拒绝 NaN/Infinity, 用 n >= min && n <= max 取代整数边界 (允许边界值).
//   不区分整数 / 小数 = "0.8" 与 "0" 都合法. 用于 goal_resume_threshold (0.0-1.0).
function parseFloatInRange(input: unknown, min: number, max: number): number | null {
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// 功能: 一个「整数型全局设置」的解析: app_settings 有合法值就用它, 否则用默认值.
// 关注点: 脏值只 warn 并回退, 绝不抛错也绝不返回 NaN —— 调用方拿这个值去
//   setTimeout / 设并发, NaN 或 0 都是静默故障(任务瞬间被挂起 / 一个任务都不跑),
//   比配置没生效难查得多。
function resolveIntSetting(opts: {
  key: string;
  min: number;
  max: number;
  fallback: number;
}): number {
  const { key, min, max, fallback } = opts;

  const stored = getSetting(key);
  if (stored !== null) {
    const n = parseIntInRange(stored, min, max);
    if (n !== null) return n;
    console.warn(
      `[settings] app_settings.${key}=${stored} 非法(需 ${min}-${max} 整数), 回退 ${fallback}`
    );
  }

  return fallback;
}

// 功能: 一个「浮点型全局设置」的解析: app_settings 有合法值就用它, 否则用默认值.
//   关注点: 与 resolveIntSetting 对称扩展, 同款「脏值 warn 回退, 不抛错」语义.
//   用于 goal_resume_threshold (0.0-1.0).
function resolveFloatSetting(opts: {
  key: string;
  min: number;
  max: number;
  fallback: number;
}): number {
  const { key, min, max, fallback } = opts;

  const stored = getSetting(key);
  if (stored !== null) {
    const n = parseFloatInRange(stored, min, max);
    if (n !== null) return n;
    console.warn(
      `[settings] app_settings.${key}=${stored} 非法(需 ${min}-${max} 浮点数), 回退 ${fallback}`
    );
  }

  return fallback;
}

// 功能: 校验一个「分钟数」输入, 合法返回整数, 非法返回 null.
// 关注点: 供 setter 和 projects.updateProject(项目级覆盖)共用, 保证两处边界一致.
export function parseTimeoutMinutes(input: unknown): number | null {
  return parseIntInRange(input, MIN_TASK_TIMEOUT_MINUTES, MAX_TASK_TIMEOUT_MINUTES);
}

// 功能: 全局默认壁钟超时(分钟). 链路: app_settings → 30.
export function getGlobalTaskTimeoutMinutes(): number {
  return resolveIntSetting({
    key: KEY_TASK_TIMEOUT_MINUTES,
    min: MIN_TASK_TIMEOUT_MINUTES,
    max: MAX_TASK_TIMEOUT_MINUTES,
    fallback: DEFAULT_TASK_TIMEOUT_MINUTES,
  });
}

// 功能: 保存全局默认壁钟超时, 返回落库的值.
// 关注点: 非法值**抛错**而不是静默夹取 —— 调用方(PATCH /api/config)需 catch 成 400,
//   静默改成边界值会让用户以为设成了自己填的数。
export function setGlobalTaskTimeoutMinutes(input: unknown, updatedBy?: string | null): number {
  const n = parseTimeoutMinutes(input);
  if (n === null) {
    throw new Error(
      `task_timeout_minutes 必须是 ${MIN_TASK_TIMEOUT_MINUTES}-${MAX_TASK_TIMEOUT_MINUTES} 的整数`
    );
  }
  setSetting(KEY_TASK_TIMEOUT_MINUTES, String(n), updatedBy);
  return n;
}

// 功能: 全局并发上限. 链路: app_settings → 2.
// 关注点: 在 AgentRuntime 构造函数里被读一次(进程启动时的初始并发)。运行中改值
//   走 setGlobalMaxConcurrency + scheduler.setConcurrency 两步 —— 只写库不改内存
//   等于要重启才生效, 只改内存不写库就是这次要修掉的老毛病。
export function getGlobalMaxConcurrency(): number {
  return resolveIntSetting({
    key: KEY_MAX_CONCURRENCY,
    min: MIN_MAX_CONCURRENCY,
    max: MAX_MAX_CONCURRENCY,
    fallback: DEFAULT_MAX_CONCURRENCY,
  });
}

// 功能: 保存全局并发上限, 返回落库的值. 非法值抛错(同 setGlobalTaskTimeoutMinutes).
// 关注点: 只负责落库, **不改调度器内存值** —— 调用方两件事都要做。
export function setGlobalMaxConcurrency(input: unknown, updatedBy?: string | null): number {
  const n = parseIntInRange(input, MIN_MAX_CONCURRENCY, MAX_MAX_CONCURRENCY);
  if (n === null) {
    throw new Error(`concurrency 必须是 ${MIN_MAX_CONCURRENCY}-${MAX_MAX_CONCURRENCY} 的整数`);
  }
  setSetting(KEY_MAX_CONCURRENCY, String(n), updatedBy);
  return n;
}

// 🆕 DAG P3 (B5 拍板 2026-09-06): 平台级 master switch 读取.
// 功能: 读全局开关, 默认 false (与今天 byte-identical).
//   'true'/'1' = 开, 其他 (缺值/'false'/'0'/null) = 关.
//   关注点: 与 task_timeout_minutes / max_concurrency 走同套路 (setSetting 存
//   字符串, 这里再判一次). 非法值一律视为关 (B5 拍板: 「关一即停」, 严禁
//   脏值意外开启).
export function resolveVerificationGloballyEnabled(): boolean {
  const raw = getSetting(KEY_VERIFICATION_GLOBALLY_ENABLED);
  if (raw === null) return false;
  return raw === "true" || raw === "1";
}

// 🆕 DAG P3 (B5): setter. 接受 boolean / 'true'/'1'/'false'/'0' 字符串.
//   关注点: 写库永远存字符串 ('true' 或 'false'), 与 task_timeout_minutes 的
//   数字字符串保持一致. 非法输入 (非 bool 非 0/1 字符串) 抛错 -> PATCH /api/config
//   路由 catch 后回 400. 不传 updatedBy 时记 null (admin 默认值).
export function setVerificationGloballyEnabled(
  input: unknown,
  updatedBy?: string | null,
): boolean {
  let normalized: boolean;
  if (typeof input === "boolean") {
    normalized = input;
  } else if (input === "true" || input === "1" || input === 1) {
    normalized = true;
  } else if (input === "false" || input === "0" || input === 0) {
    normalized = false;
  } else {
    throw new Error(
      `${KEY_VERIFICATION_GLOBALLY_ENABLED} 必须是 boolean 或 'true'/'false' (也接受 1/0)`,
    );
  }
  setSetting(KEY_VERIFICATION_GLOBALLY_ENABLED, normalized ? "true" : "false", updatedBy);
  return normalized;
}

// 功能: 解析「schedule_runs 清理阈值」输入, 合法返回整数, 非法返回 null.
// 关注点: 供 setter 用; 0 是合法值 (= 关闭该维度清理), 与 max_concurrency
//   (>=1) 不同. 注意: 0 假值在 JS 里会让 setSetting 不写库? 不, setSetting 用字符串
//   落库, "0" 与 0 不同 —— 这里显式保留数字语义.
export function parseScheduleRunsTtlDays(input: unknown): number | null {
  return parseIntInRange(input, MIN_SCHEDULE_RUNS_TTL_DAYS, MAX_SCHEDULE_RUNS_TTL_DAYS);
}
export function parseScheduleRunsKeepLastN(input: unknown): number | null {
  return parseIntInRange(input, MIN_SCHEDULE_RUNS_KEEP_LAST_N, MAX_SCHEDULE_RUNS_KEEP_LAST_N);
}

// 功能: 全局 schedule_runs 年龄阈值 (天). 链: app_settings → 30. 0 = 不按年龄清.
// 关注点: 同 task_timeout_minutes / max_concurrency, 脏值 warn 回退默认值,
//   不抛错也不返 NaN —— purgeOldRuns 拿到 null 会跳过该层清理, 比静默炸好.
export function getGlobalScheduleRunsTtlDays(): number {
  return resolveIntSetting({
    key: KEY_SCHEDULE_RUNS_TTL_DAYS,
    min: MIN_SCHEDULE_RUNS_TTL_DAYS,
    max: MAX_SCHEDULE_RUNS_TTL_DAYS,
    fallback: DEFAULT_SCHEDULE_RUNS_TTL_DAYS,
  });
}

// 功能: 全局 schedule_runs 每 schedule 保留 N 条. 链: app_settings → 100. 0 = 不按数量清.
export function getGlobalScheduleRunsKeepLastN(): number {
  return resolveIntSetting({
    key: KEY_SCHEDULE_RUNS_KEEP_LAST_N,
    min: MIN_SCHEDULE_RUNS_KEEP_LAST_N,
    max: MAX_SCHEDULE_RUNS_KEEP_LAST_N,
    fallback: DEFAULT_SCHEDULE_RUNS_KEEP_LAST_N,
  });
}

// 功能: 保存全局 schedule_runs 清理阈值. 非法值抛错 (同其它 setter, 给 PATCH /api/config
//   返回 400). 返回落库的整数.
// 关注点: 0 是合法值 (=关闭该维度), 用 parseIntInRange 已经覆盖. 调用方
//   (PATCH 路由 + 内部 runner) 都拿同一个 setter 保证校验口径一致.
export function setGlobalScheduleRunsTtlDays(input: unknown, updatedBy?: string | null): number {
  const n = parseScheduleRunsTtlDays(input);
  if (n === null) {
    throw new Error(
      `schedule_runs_ttl_days 必须是 ${MIN_SCHEDULE_RUNS_TTL_DAYS}-${MAX_SCHEDULE_RUNS_TTL_DAYS} 的整数`
    );
  }
  setSetting(KEY_SCHEDULE_RUNS_TTL_DAYS, String(n), updatedBy);
  return n;
}
export function setGlobalScheduleRunsKeepLastN(input: unknown, updatedBy?: string | null): number {
  const n = parseScheduleRunsKeepLastN(input);
  if (n === null) {
    throw new Error(
      `schedule_runs_keep_last_n 必须是 ${MIN_SCHEDULE_RUNS_KEEP_LAST_N}-${MAX_SCHEDULE_RUNS_KEEP_LAST_N} 的整数`
    );
  }
  setSetting(KEY_SCHEDULE_RUNS_KEEP_LAST_N, String(n), updatedBy);
  return n;
}

// 功能: 解析一段「端口池 JSON 字符串」成 [[start,end], ...] 数组. 非法返回 null.
// 关注点: 校验起止都是 1024-65535 整数 + 1<=起<=止, 段数 1-8. 单段是允许的
//   ([13100,13100] = 一个固定端口). getPortPool 调这个解析, setPortPool 也用它
//   做落库前的二次校验(防库里脏值). 调用方 catch 后给 400.
function parsePortPoolJson(raw: string): PortPoolRanges | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_POOL_SEGMENTS) {
    return null;
  }
  const out: Array<readonly [number, number]> = [];
  for (const seg of parsed) {
    if (!Array.isArray(seg) || seg.length !== 2) return null;
    const a = Number(seg[0]);
    const b = Number(seg[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a < MIN_PORT || a > MAX_PORT || b < MIN_PORT || b > MAX_PORT) return null;
    if (a > b) return null;
    out.push([a, b]);
  }
  return out;
}

// 功能: 读全局端口池. 链: app_settings.port_pool → DEFAULT_PORT_POOL.
// 关注点: 脏值 warn 并回退(同 resolveIntSetting 的降级语义).
export function getPortPool(): PortPoolRanges {
  const raw = getSetting(KEY_PORT_POOL);
  if (raw !== null) {
    const parsed = parsePortPoolJson(raw);
    if (parsed !== null) return parsed;
    console.warn(
      `[settings] app_settings.${KEY_PORT_POOL}=${raw} 非法, 回退默认池`,
    );
  }
  return DEFAULT_PORT_POOL;
}

// 功能: 保存全局端口池. 非法值抛错(同 setGlobalMaxConcurrency).
// 关注点: 输入既可以是 [[a,b],...] 也接受扁平 number[] ([a,b,c,d] = 两段
//   [a,b]+[c,d]). PATCH 路由 catch 后回 400 + message.
export function setPortPool(input: unknown, updatedBy?: string | null): PortPoolRanges {
  let candidate: unknown = input;
  if (Array.isArray(input) && input.length > 0 && typeof input[0] === "number") {
    // 扁平 4 个 = 一段; 6 个 = 两段; 奇数或不是 2 的倍数 → 错.
    if (input.length % 2 !== 0) {
      throw new Error(`port_pool 扁平格式必须是 2 的倍数个整数, 收到 ${input.length}`);
    }
    candidate = [];
    for (let i = 0; i < input.length; i += 2) {
      (candidate as number[][]).push([input[i] as number, input[i + 1] as number]);
    }
  }
  const raw = JSON.stringify(candidate);
  const parsed = parsePortPoolJson(raw);
  if (parsed === null) {
    throw new Error(
      `port_pool 必须是 [[start,end],...] 格式, 每段 ${MIN_PORT}-${MAX_PORT} 整数且 start<=end, 最多 ${MAX_POOL_SEGMENTS} 段`,
    );
  }
  setSetting(KEY_PORT_POOL, raw, updatedBy);
  return parsed;
}

// 功能: 校验一个端口是否落在当前池里. 没池 (DEFAULT_PORT_POOL 默认含 13000-13099)
//   永远 true; 配置了更窄的池则只放行落在任意段内的端口.
// 关注点: 这是 routes/projects 的「项目端口必须落在池里」判据, 不会去查跨项目
//   冲突 —— 冲突由调用方 (createProject / updateProject) 拿 usedPorts 集合一起算.
export function isPortInPool(port: number): boolean {
  const pool = getPortPool();
  for (const [start, end] of pool) {
    if (port >= start && port <= end) return true;
  }
  return false;
}

// 🆕 R200 turn2 (damo 1006 chat 拍板): 系统统一 summary 模型 — result-layers /
//   card-summary / auto-rename 标题 三处摘要类 LLM 统一走它, fallback 链跟该
//   配置自身的 fallback_ids (R175 字段, summary-llm.ts 首次运行时消费).
//   协议: app_settings.summary_llm_config_id 落 llm_config id; 空 / 配置已删 →
//   链自动降级到任务配置链 → env (见 runtime/summary-llm.ts).
export const KEY_SUMMARY_LLM_CONFIG_ID = "summary_llm_config_id";

// 功能: 读系统 summary 模型配置 id. 链: app_settings → null (未配).
export function getSummaryLlmConfigId(): string | null {
  const raw = getSetting(KEY_SUMMARY_LLM_CONFIG_ID);
  if (raw !== null && raw.trim() !== "") return raw.trim();
  return null;
}
