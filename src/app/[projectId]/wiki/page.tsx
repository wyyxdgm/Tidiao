// /[projectId]/wiki - 项目级 Markdown Wiki 浏览器 (按 ?version= 读对应版本 cwd, 默认 current version)

import { notFound, redirect } from "next/navigation";
import { getProjectById, listProjects } from "@/lib/db/projects";
import { listVersions } from "@/lib/db/versions";
import { getServerRole, getServerUserId } from "@/lib/server-auth";
import { allowedExtensions } from "@/lib/wiki-files";
import { decideAbsolutePathRedirect } from "@/lib/wiki-links";
import WikiClient from "./wiki-client";

interface Props {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ version?: string; path?: string }>;
}

export default async function WikiPage({ params, searchParams }: Props) {
  const { projectId } = await params;
  const { version, path: rawPath } = await searchParams;
  const userId = await getServerUserId();
  // Admin sees every project (matches /api/projects list semantics); non-admin
  // is scoped to its own owner_id.
  const ownerId = (await getServerRole()) === "admin" ? undefined : userId;
  const project = getProjectById(projectId, ownerId);
  if (!project) notFound();

  // 解析初始 versionId: ?version= 优先, 否则 current_version_id, 再否则第一个版本, 都没有则 null(读 project.cwd).
  const versions = listVersions(projectId, ownerId);
  const versionId = version || project.current_version_id || versions[0]?.id || null;

  // 用户可见项目 cwd 列表(给绝对路径笔记链接自动识别用; 只取非空 cwd 的).
  const allProjects = listProjects(ownerId, "created_at");
  const projectsWithCwd = allProjects
    .filter((p): p is typeof p & { cwd: string } => !!p.cwd)
    .map((p) => ({ id: p.id, cwd: p.cwd as string }));

  // 服务端绝对路径规范化: 用户直接访问 /{id}/wiki?path=/ws/<...>/foo.md 时,
  // 把它重定向到正确的项目 + 相对路径. 不动 safeResolve 的安全语义 —— 这一层
  // 只在 server component 入口做跳转, API route 仍按原样只接受相对路径.
  // 关注点: 跨用户隔离由 listProjects(userId) 的 owner 过滤保证; 决策函数
  // decideAbsolutePathRedirect 与前端 markdown 链接拦截共用 resolveAbsoluteProjectPath,
  // 行为(最长前缀 cwd 匹配)完全一致. 决策详情见该函数注释.
  // homeDir 取自 process.env.HOME, 给客户端传来的 mac/~ / shorthand 形式补 home 前缀
  // 后再匹配(详见 normalizeHrefForCwdMatch).
  const homeDir = process.env.HOME || "/home/user";
  const decision = decideAbsolutePathRedirect(rawPath, projectId, projectsWithCwd, version, homeDir);
  if (decision.kind === "redirect") {
    redirect(decision.targetUrl);
  }
  // kind === "pass": 非绝对路径 / 没匹配, 维持原行为(rawPath 透传给 API, 后端 404).

  return (
    <WikiClient
      project={{ id: project.id, name: project.name }}
      versionId={versionId}
      versions={versions.map((v) => ({ id: v.id, name: v.name }))}
      // 放行扩展名跟着 project 走(不是 version) —— 配置存在 projects 表上.
      allowedExts={[...allowedExtensions(project.wiki_extra_extensions)]}
      projects={projectsWithCwd}
    />
  );
}
