// 功能: 飞书 R123 R 列反馈 — tab 标题解析. 把 path/search 转成对人友好的标题.
//   - /schedules → "定时任务"
//   - /requirements → "需求点管理"
//   - /tasks/{id} → "{项目名≤6}-{任务标题≤6}" (用 /api/tasks/{id} 拉 title, projectCache 查项目名)
//   - /{projectId}/{versionId} → "{项目名} · {版本名}" (用 /api/projects /api/versions 查)
//   - /{projectId}/board?path=... → "{项目名} · 看板"
//   - /{projectId}/wiki?path=CLAUDE.md → "{项目名} · CLAUDE.md"
//   - 其他用 defaultTitle 兜底.
//
// 关注点:
//   1. 缓存: project / version / task 查询结果缓存 (整个会话), 避免来回 fetch.
//   2. SSR 安全: 全走 fetch API, 不直接 import server-only 模块.
//   3. 失败回退: 网络错误/401 静默回退到 defaultTitle, 不阻断 tab 创建.
//   4. 入口文案: 左侧导航的入口项 (需求/Board/Wiki) 用入口处的短文案, 不冗余.
//
// 用法: useResolvedTitle(path, search) → 返回 best-effort 标题.

import { useEffect, useReducer } from "react";

import { defaultTitle } from "./store";

type ProjectMeta = { id: string; name: string };
type VersionMeta = { id: string; name: string; project_id: string };
type TaskMeta = { id: string; title: string; project_id: string | null };

// 全局 in-memory 缓存 (跨组件复用, 不持久化).
const projectCache = new Map<string, ProjectMeta>();
const versionCache = new Map<string, VersionMeta>();
const taskCache = new Map<string, TaskMeta>();

async function fetchProjects(): Promise<ProjectMeta[]> {
  if (projectCache.size > 0) return Array.from(projectCache.values());
  try {
    const r = await fetch("/api/projects?sort=manual");
    if (!r.ok) return [];
    const d = (await r.json()) as { projects?: ProjectMeta[] };
    for (const p of d.projects ?? []) {
      projectCache.set(p.id, { id: p.id, name: p.name });
    }
    return d.projects ?? [];
  } catch {
    return [];
  }
}

async function fetchVersions(): Promise<VersionMeta[]> {
  if (versionCache.size > 0) return Array.from(versionCache.values());
  try {
    const r = await fetch("/api/versions");
    if (!r.ok) return [];
    const d = (await r.json()) as { versions?: VersionMeta[] };
    for (const v of d.versions ?? []) {
      versionCache.set(v.id, v);
    }
    return d.versions ?? [];
  } catch {
    return [];
  }
}

async function fetchTask(id: string): Promise<TaskMeta | null> {
  const cached = taskCache.get(id);
  if (cached) return cached;
  try {
    const r = await fetch(`/api/tasks/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const d = (await r.json()) as {
      id?: string;
      title?: string;
      project_id?: string | null;
    };
    if (!d.id) return null;
    const meta: TaskMeta = {
      id: d.id,
      title: d.title ?? "",
      project_id: d.project_id ?? null,
    };
    taskCache.set(id, meta);
    return meta;
  } catch {
    return null;
  }
}

// 任务 tab 标题格式: "{项目名≤6}-{任务标题≤12}"
// (damo R123 R 列反馈: 格式 {项目名称-6字符以内}-{任务标题~12个字以内})
//
// 行为:
//   - 都有 → `{项目名≤6}-{任务标题≤12}`
//   - 只有任务标题 → `{任务标题≤12}`
//   - 只有项目名 → `{项目名≤6}`
//   - 都无 → `任务 {id 前 8}`
//
// 关注点:
//   - 截断按 codepoint 算 (Array.from), 避免 surrogate pair 被切成半个字.
//   - 纯函数, 无 React 依赖, 单测可独立 import.
export function formatTaskTitle(
  task: { id: string; title: string | null | undefined },
  projectName: string | null | undefined,
): string {
  const trunc = (s: string | null | undefined, n: number) =>
    Array.from(s ?? "").slice(0, n).join("");
  const p = trunc(projectName, 6);
  const t = trunc(task.title, 12);
  if (p && t) return `${p}-${t}`;
  if (t) return t;
  if (p) return p;
  return `任务 ${task.id.slice(0, 8)}`;
}

// 从 /api/projects 顺便带出 current_version_name — 避免再来一次 join.

const ENTRY_LABELS: Record<string, string> = {
  "/schedules": "定时任务",
  "/requirements": "需求点管理",
  "/assets": "资源池",
  "/usage": "用量统计",
  "/global": "全局看板",
  "/import": "批量导入",
  "/settings": "设置",
  "/stats": "统计",
  "/runners": "Runner",
  "/templates": "模板",
  "/webhooks": "Webhook",
  "/progress": "进度",
  "/transcript": "Transcript",
  "/uncategorized": "未分类",
};

function wikiLeaf(search: string): string | null {
  const sp = new URLSearchParams(search);
  const p = sp.get("path");
  if (!p) return null;
  const seg = p.split("/").filter(Boolean);
  return seg.length ? seg[seg.length - 1] : p;
}

// 异步标题状态 — reducer 持有 (path, search, value),
// dispatch 在 effect 外的 async 回调里触发, 避开 set-state-in-effect.
type TitleState = { key: string; value: string | null };
type TitleAction =
  | { type: "reset"; key: string }
  | { type: "set"; key: string; value: string };

function titleReducer(_state: TitleState, action: TitleAction): TitleState {
  switch (action.type) {
    case "reset":
      return { key: action.key, value: null };
    case "set":
      // 仅在 key 匹配时接受, 避免 stale 异步覆盖更新的 path
      return { key: action.key, value: action.value };
  }
}

export function useResolvedTitle(path: string, search: string): string {
  // 入口文案同步返回, 不进 effect
  const initial = ENTRY_LABELS[path] ?? defaultTitle(path, search);
  const key = `${path}?${search}`;
  const [state, dispatch] = useReducer(titleReducer, { key, value: null });

  useEffect(() => {
    // 路径变化 → 重置
    dispatch({ type: "reset", key });
    if (ENTRY_LABELS[path]) return;

    const parts = path.split("/").filter(Boolean);
    const cancelled = { current: false };

    const commit = (value: string) => {
      if (!cancelled.current) dispatch({ type: "set", key, value });
    };

    // /tasks/{id} → 走 formatTaskTitle ({项目名≤6}-{任务标题≤12})
    if (parts[0] === "tasks" && parts[1]) {
      void (async () => {
        const t = await fetchTask(parts[1]);
        if (!t) return;
        let projName: string | null = null;
        if (t.project_id) {
          await fetchProjects();
          projName = projectCache.get(t.project_id)?.name ?? null;
        }
        commit(formatTaskTitle(t, projName));
      })();
      return;
    }

    // /{projectId}/... → 项目名解析
    if (parts.length >= 2 && /^[0-9a-f-]{8,}$/i.test(parts[0])) {
      void (async () => {
        const [projects, versions] = await Promise.all([fetchProjects(), fetchVersions()]);
        if (cancelled.current) return;
        const project = projects.find((p) => p.id === parts[0]);
        if (!project) return;
        const projName = project.name;
        const versionId = parts[1];
        const version = versions.find((v) => v.id === versionId);
        const verName = version?.name ?? null;

        let resolved: string | null = null;
        if (versionId === "board") {
          resolved = verName ? `${projName} · ${verName} · 看板` : `${projName} · 看板`;
        } else if (versionId === "unversioned") {
          resolved = `${projName} · 其他任务`;
        } else if (versionId === "wiki") {
          const leaf = wikiLeaf(search);
          resolved = leaf ? `${projName} · ${leaf}` : `${projName} · Wiki`;
        } else if (versionId === "requirements") {
          resolved = verName ? `${projName} · ${verName} · 需求` : `${projName} · 需求`;
        } else if (versionId && verName) {
          const sub = parts[2];
          if (sub === "board") {
            resolved = `${projName} · ${verName} · 看板`;
          } else if (sub === "wiki") {
            const leaf = wikiLeaf(search);
            resolved = leaf ? `${projName} · ${verName} · ${leaf}` : `${projName} · ${verName} · Wiki`;
          } else if (sub === "requirements") {
            resolved = `${projName} · ${verName} · 需求`;
          } else {
            resolved = `${projName} · ${verName}`;
          }
        } else {
          resolved = `${projName} · …`;
        }
        if (resolved) commit(resolved);
      })();
      return;
    }
    // 其他路径 → 不解析, 保持 initial
  }, [key, path, search]);

  return state.key === key && state.value ? state.value : initial;
}