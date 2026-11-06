// /[projectId]/board?path=boards/x.md[&version=...]
//
// 功能: 看板页面入口 —— 服务端读 board 文件, 解析 frontmatter + body, 把 config
//       和原始 HTML 一起传给 client, 由 client 在 iframe sandbox 里渲染.
// 关注点:
//  - 不在 server 直接执行 data source —— SSR 阶段拿不到当前用户的鉴权 cookie, 也
//    会让页面等所有 source 跑完才返回. 数据拉取交给 client fetch (带 x-user-id).
//  - 不做 owner 过滤: 项目级页面已经走过 listProjects(userId) / getProjectById 鉴权.
//  - 文件解析统一走 resolveBoardFile (R91): 项目 cwd 优先, 没有则回落平台内置 boards/,
//    所以 boards/project-progress.md 这类全局看板不必往每个项目仓复制一份.

import { notFound } from "next/navigation";
import fs from "node:fs";
import { getProjectById, listProjects } from "@/lib/db/projects";
import { listVersions } from "@/lib/db/versions";
import { getServerRole, getServerUserId } from "@/lib/server-auth";
import { parseBoardFile, resolveBoardFile } from "@/lib/board";
import BoardClient from "./board-client";

interface Props {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ path?: string; version?: string }>;
}

export default async function BoardPage({ params, searchParams }: Props) {
  const { projectId } = await params;
  const { path: rawPath, version } = await searchParams;
  const userId = await getServerUserId();
  // Admin sees every project (matches /api/projects list semantics); non-admin
  // is scoped to its own owner_id.
  const ownerId = (await getServerRole()) === "admin" ? undefined : userId;
  const project = getProjectById(projectId, ownerId);
  if (!project) notFound();

  const versions = listVersions(projectId, ownerId);
  const versionId = version || project.current_version_id || versions[0]?.id || null;
  const versionObj = versionId ? versions.find((v) => v.id === versionId) : null;
  const cwd = versionObj?.cwd || project.cwd;

  // allProjects 给前端跨项目跳转用 (无跳转需求时可省)
  const allProjects = listProjects(ownerId, "created_at")
    .filter((p): p is typeof p & { cwd: string } => !!p.cwd)
    .map((p) => ({ id: p.id, name: p.name, cwd: p.cwd as string }));

  // R91 第二步: 默认 boardPath 改成 boards/my-project.md —— 每个项目点 Board 自动看本项目视图
  // (ctx 注入 project_id, SQL 只看当前项目). 想看全平台改 ?path=boards/project-progress.md.
  // 旧默认 boards/INDEX.md 不存在, 回落不到 = 引导页 —— 现在用 my-project.md 永远有内容.
  const boardPath = rawPath?.trim() || "boards/my-project.md";

  if (!cwd) {
    return (
      <div className="p-8 text-gray-500">
        本项目未配置 cwd, 无法加载 board. 请在项目设置里设置 cwd.
      </div>
    );
  }

  let cwdReal: string;
  try {
    cwdReal = fs.realpathSync(cwd);
  } catch {
    return <div className="p-8 text-gray-500">cwd 不存在: {cwd}</div>;
  }

  const resolved = resolveBoardFile(cwdReal, boardPath);
  if (resolved === null) {
    return (
      <div className="p-8">
        <h1 className="text-lg font-medium mb-2">找不到 board 文件</h1>
        <p className="text-sm text-gray-600 mb-4">
          路径: <code>{boardPath}</code> (先找项目 cwd, 再回落平台内置 <code>boards/</code>, 两边都没有)
        </p>
        <div className="text-sm text-gray-500">
          <p className="mb-2">在 <code>{cwd}</code> 下创建该文件, frontmatter 形如:</p>
          <pre className="bg-gray-50 p-3 rounded text-xs overflow-auto">{`---
title: 我的看板
refresh: 30s
sources:
  - name: projects
    kind: api
    path: /api/projects
---
<div id="app"></div>
<script>
  fetch(window.__DATA__.projects).then(r => r.json()).then(d => {
    document.getElementById('app').innerText = JSON.stringify(d, null, 2);
  });
</script>`}</pre>
        </div>
      </div>
    );
  }

  const parsed = parseBoardFile(resolved.content);

  return (
    <BoardClient
      project={{ id: project.id, name: project.name }}
      boardPath={boardPath}
      versionId={versionId}
      projects={allProjects}
      initialConfig={parsed.config}
      initialBody={parsed.body}
    />
  );
}
