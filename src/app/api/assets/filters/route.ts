// GET /api/assets/filters - 返回可筛 project/version 列表.
//
// 给 /assets 页面下拉用: 用户名下所有有 attachment 的 project (含 version).
// 跨 owner 隔离: owner_id = userId 兜底.
//
// 关注点:
//   - 只返有 attachment 的 project/version (JOIN attachments) -- 避免下拉里出现
//     "选了没东西" 的空选项.
//   - 同时返每项的 attachment count (供下拉标签显示).

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();

  // 找出当前用户下, 实际有 attachment 的 project + version 组合.
  // 用 LEFT JOIN 到 projects / versions, 兼容 task.project_id / version_id 为 NULL
  // (未绑定项目的 task) 的场景, 一并返回 null 标记.
  const rows = db
    .prepare(`
      SELECT
        t.project_id,
        t.version_id,
        COUNT(a.id) AS count
      FROM attachments a
      LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.owner_id = ?
      GROUP BY t.project_id, t.version_id
      ORDER BY t.project_id, t.version_id
    `)
    .all(userId) as Array<{
      project_id: string | null;
      version_id: string | null;
      count: number;
    }>;

  // 拉 project / version 名字, 一次拿.
  const projects = db
    .prepare(`SELECT id, name FROM projects WHERE owner_id = ? AND deleted_at IS NULL`)
    .all(userId) as Array<{ id: string; name: string }>;
  const projMap = new Map(projects.map((p) => [p.id, p.name]));

  const versions = db
    .prepare(`
      SELECT v.id, v.name, v.project_id
      FROM versions v
      JOIN projects p ON p.id = v.project_id
      WHERE p.owner_id = ? AND v.deleted_at IS NULL AND p.deleted_at IS NULL
    `)
    .all(userId) as Array<{ id: string; name: string; project_id: string }>;
  const verMap = new Map(versions.map((v) => [v.id, v]));

  type OutProj = {
    id: string;
    name: string;
    count: number;
    versions: Array<{ id: string; name: string; count: number }>;
  };

  const projectMap = new Map<string, OutProj>();
  let orphanCount = 0; // project_id 为 NULL 的 attachment 计数

  for (const r of rows) {
    if (!r.project_id) {
      orphanCount += r.count;
      continue;
    }
    let p = projectMap.get(r.project_id);
    if (!p) {
      p = {
        id: r.project_id,
        name: projMap.get(r.project_id) ?? "(已删除项目)",
        count: 0,
        versions: [],
      };
      projectMap.set(r.project_id, p);
    }
    p.count += r.count;
    if (r.version_id) {
      const v = verMap.get(r.version_id);
      p.versions.push({
        id: r.version_id,
        name: v?.name ?? "(已删除版本)",
        count: r.count,
      });
    }
  }

  return NextResponse.json({
    projects: Array.from(projectMap.values()),
    orphan_count: orphanCount,
  });
}