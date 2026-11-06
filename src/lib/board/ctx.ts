// Board source ctx 注入 (R91 第二步).
//
// 功能: 把当前 board 上下文 (project_id / owner_id) 注入到 api kind 的 source 里.
//   - path 里的 `{project_id}` 占位符会被替换;
//   - query 自动追加 project_id (除非作者已在 query 里写过同名 key —— 作者覆盖优先).
//   注意: SQL kind 不走这里 —— sql-executor.ts 自带 injectOwnerFilter / injectProjectFilter,
//   SQL 注入要求精细 (匹配 FROM/JOIN 别名, 跳过显式 project_id 过滤), 跟 ctx.ts 不是一个赛道.
//
// 关注点:
//   - 这是 board 作者最常用的快捷方式: 写 `/api/projects/{project_id}/tasks` 自动展开,
//     或者直接写 `/api/projects/...` 让 ctx 加 `?project_id=xxx`. 两种风格按需选用.
//   - 占位符走 `{key}` 全局替换; 非法 key (含 `-` 等) 直接抛, 防被当字面量吞掉.
//   - ctx 是**只读输入**, 不修改原 source; 调用方拿到的是新对象.

export interface BoardSourceCtx {
  projectId?: string;
  ownerId: string;
}

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export interface ApiSourceForCtx {
  kind: "api";
  path: string;
  query?: Record<string, string>;
}

/**
 * 把 ctx 注入到 api source, 返回新对象 (不改原 source).
 * 占位符替换: {project_id} / {owner_id} 走 ctx 对应字段.
 * 自动追加 query: project_id (若 query 未显式给).
 */
export function applyApiSourceCtx(
  source: ApiSourceForCtx,
  ctx: BoardSourceCtx
): { path: string; query: Record<string, string> } {
  // 占位符: path 里出现 {project_id} / {owner_id} → 替换
  const replacements: Record<string, string | undefined> = {
    project_id: ctx.projectId,
    owner_id: ctx.ownerId,
  };
  const newPath = source.path.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const v = replacements[key];
    if (v === undefined) {
      throw new Error(`unknown placeholder {${key}} in api source path (allowed: project_id, owner_id)`);
    }
    return encodeURIComponent(v);
  });

  // 合并 query: 作者显式给的优先, 再自动追加 ctx 默认
  const merged: Record<string, string> = { ...(source.query || {}) };
  if (ctx.projectId && merged.project_id === undefined) {
    merged.project_id = ctx.projectId;
  }

  return { path: newPath, query: merged };
}

/**
 * 给一段 URL 拼 query string. 已有 ? 时拼 &, 没有时拼 ?.
 * 空 query 直接返回原 path.
 */
export function appendQueryString(path: string, query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return path;
  const qs = new URLSearchParams(query).toString();
  return path + (path.includes("?") ? "&" : "?") + qs;
}
