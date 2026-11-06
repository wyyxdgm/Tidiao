// GET /api/tasks/page — 看板专用分页端点.
//
// 与 /api/tasks (listTasks 全字段 + 无信封) 共存: 后者继续服务 progress /
// tasks/new / shell 脚本等需要 SELECT * 的调用方; 本端点专供 /global 和
// /[projectId]/[versionId] 看板 — 状态按 active/terminal 分流, payload
// 精简投影 (TaskTrimmed, 20 字段; 详见 types.ts).
//
// 信封形态: { items, total, hasMore }. 不要 nextOffset — 客户端用 offset + limit
// 算即可 (避免冗余).
//
// 入参:
//   - statusGroup: "active" | "terminal" | "all" (必填, 看板分流真相之源)
//   - project: 可选, 收窄到某 project
//   - version: 可选, 收窄到某 version (与 project 同时传)
//   - unversioned=true: 仅 project 下的未绑定 version 任务
//   - includeDeleted=true: 含软删 (默认过滤)
//   - limit: 默认 50, 上限 200 (挡超大页)
//   - offset: 默认 0
//   - q: 可选, 非空时服务端 LIKE 搜索 title/description/prompt (R114 后台搜索, 大小写不敏感).
//       与客户端 matchesTaskSearch 协同: q 命中时服务端已收窄, 客户端 useMemo 过滤变为 no-op.
//   - model: 可选, 精确匹配 tasks.model (R114 第二轮, 筛选全走后端).
//   - tag: 可选, 精确匹配 tags JSON 数组中的任一项 (R114 第二轮).
//   - statuses: 可选, 逗号分隔精确状态集 (R236 跨组混选, 如 "running,completed").
//       AND 语义 — 在 statusGroup 段内收窄 (跨组混选时前端拉 active+terminal 两段,
//       每段各自 AND 出组内选中子集, 拼接不重不漏); 非法值丢弃, 全非法 = 仅分组过滤.
//
// 不鉴权走 401; 鉴权失败 / statusGroup 非法 / 项目不属于当前用户 → 404 (避免
// 存在性泄漏, 与 GET /api/tasks 同款).
//
// R165 条件拉取 (ETag):
//   - 每次 200 响应带 `ETag: W/"<行集指纹> p<limit>-<offset>"`, `Cache-Control: no-cache`.
//   - 客户端带 `If-None-Match: <上次 etag>` 回来, 指纹 + 页窗口都没变 → 304 无 body.
//   - 指纹来自 listTasksPageFingerprint (COUNT + MAX(updated_at) + requirements /
//     checkpoints 的全局 MAX), 只跑聚合不 hydrate, 供前端"后台每分钟探一次,
//     没变就不拉全量"用. 详见 docs/plans/r165-resident-background-sync.md.

import { NextRequest, NextResponse } from "next/server";
import {
  listTasksPage,
  listTasksPageFingerprint,
  runTasksPageStatusRows,
  ACTIVE_STATUSES,
  PAGE_TERMINAL_STATUSES,
  type StatusGroup,
} from "@/lib/db/tasks";
import { getProjectById } from "@/lib/db/projects";

const STATUS_GROUPS: ReadonlySet<StatusGroup> = new Set<StatusGroup>([
  "active",
  "terminal",
  "all",
]);

// 飞书 AO-DEV R236: statuses 精确状态集的合法值域 = active ∪ terminal 全部 11 态.
// route 层负责校验 + 去重 (非法值静默丢弃; 全非法 = 不加精确收窄), db 层
// (buildTasksPageWhere) 把它与 statusGroup 分组条件 AND 叠加, 不重复校验.
const PAGE_ALL_STATUSES: ReadonlySet<string> = new Set<string>([
  ...ACTIVE_STATUSES,
  ...PAGE_TERMINAL_STATUSES,
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusGroupRaw = searchParams.get("statusGroup");
  if (!statusGroupRaw || !STATUS_GROUPS.has(statusGroupRaw as StatusGroup)) {
    return NextResponse.json(
      {
        error: "statusGroup is required (one of: active, terminal, all)",
        code: "INVALID_STATUS_GROUP",
      },
      { status: 400 }
    );
  }
  const statusGroup = statusGroupRaw as StatusGroup;

  const projectId = searchParams.get("project") || undefined;
  const versionId = searchParams.get("version") || undefined;
  const unversioned = searchParams.get("unversioned") === "true";
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  // v57 (R15 task 收藏): ?favorite=true 走 listTasksPage 的 EXISTS 子查询,
  // 配合 ownerId=userId (本路由强制) 实现"只看当前用户收藏".
  const favorite = searchParams.get("favorite") === "true";

  if (unversioned && !projectId) {
    return NextResponse.json(
      { error: "project is required for unversioned task queries" },
      { status: 400 }
    );
  }

  // 收窄到 project 时, 必须校验归属 (避免横向泄漏). 非法或不属于当前用户 → 404.
  if (projectId && !getProjectById(projectId, userId)) {
    return NextResponse.json(
      { error: "Project not found", code: "PROJECT_NOT_FOUND" },
      { status: 404 }
    );
  }

  const limitRaw = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json(
        { error: "limit must be a positive integer" },
        { status: 400 }
      );
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const offsetRaw = searchParams.get("offset");
  let offset = 0;
  if (offsetRaw !== null) {
    const parsed = parseInt(offsetRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return NextResponse.json(
        { error: "offset must be a non-negative integer" },
        { status: 400 }
      );
    }
    offset = parsed;
  }

  // R114 (后台搜索): q 直接透传给 listTasksPage, 由其内部 LOWER + LIKE 处理.
  // 前端 URL 编码, 服务端不解析特殊字符 (无注入风险, 走参数化绑定).
  const q = searchParams.get("q") || undefined;
  // R114 第二轮 (筛选全走后端): model + tag 也透传给 listTasksPage.
  const model = searchParams.get("model") || undefined;
  const tag = searchParams.get("tag") || undefined;

  // 飞书 AO-DEV R236: statuses=逗号分隔精确状态集 (跨组混选, 如 running,completed).
  // 非法值丢弃 + 去重; 校验后为空 = 不加精确收窄, 仅 statusGroup 分组过滤 (向后兼容).
  const statusesRaw = searchParams.get("statuses");
  const statuses = statusesRaw
    ? [...new Set(statusesRaw.split(",").map((s) => s.trim()).filter((s) => PAGE_ALL_STATUSES.has(s)))]
    : undefined;
  const statusesFiltered =
    statuses && statuses.length > 0 ? (statuses as (typeof ACTIVE_STATUSES)[number][]) : undefined;

  const filter = {
    statusGroup,
    project_id: projectId,
    version_id: versionId,
    unversioned,
    ownerId: userId,
    includeDeleted,
    favorite,
    q,
    model,
    tag,
    statuses: statusesFiltered,
  };

  // R165 条件拉取: 客户端带 If-None-Match 回来, 指纹没变 → 304 空响应.
  //
  // ETag 组成 = 行集指纹 + 当前页窗口 (limit-offset). ⚠️ 窗口必须进 ETag:
  // 同一行集下翻页(offset 变)拿到的 items 不同, 复用同一 ETag 会让 304 把
  // 上一页的数据当本页返回 —— 静默错页, 比多拉一次严重得多.
  //
  // ⚠️ 分隔符用 `|` 不用空格: RFC 9110 的 entity-tag 里不允许裸空格, 浏览器
  // / 代理 / curl 在回传时会把它截断 —— 实测踩过 (e2e 跑到的是 200 不是 304).
  // GROUP BY status 只跑一次, fingerprint 与 listTasksPage 共享 (压测实证:
  // 旧行为同请求扫两遍 ~4800 行, terminal 段白白多花 ~40% 服务端耗时).
  const statusRows = runTasksPageStatusRows(filter);
  const etag = `${listTasksPageFingerprint(filter, statusRows)}|${limit}-${offset}`;
  const inm = request.headers.get("if-none-match");
  // 精确比 + 逗号分隔多值容忍 (客户端可能缓存了旧 ETag 列表).
  if (inm && inm.split(",").some((v) => v.trim() === etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "no-cache" },
    });
  }

  const result = listTasksPage({ ...filter, limit, offset }, statusRows);

  return NextResponse.json(result, {
    headers: { ETag: etag, "Cache-Control": "no-cache" },
  });
}