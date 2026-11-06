// GET /api/projects/[id]/wiki/tree
// 递归列出 version.cwd||project.cwd 下 wiki 可读的文件(深度 5), 供 wiki 左栏导航.
// 关注点: realpath 锁死 cwd; 深度限制 5 防过大目录; 放行扩展名由项目配置决定
//        (默认只 .md, 见 lib/wiki-files.ts); 跳过隐藏目录/文件(.git/.env 等) 和
//        默认黑名单目录(node_modules/dist/build/...), 这两条都不受配置影响.
//
//        飞书 AO-DEV R76: 原深度 3 截断了深层文档(GDM R6 等); 默认黑名单是为
//        node_modules 等「噪音目录」污染左栏 —— 它们的子树里几乎不含人工维护的
//        markdown, 加进 wiki 只会让几百个 .md 把左栏撑爆, 用户真实想看的文档
//        反而被挤到看不见。

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getProjectById } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import { allowedExtensions, isAllowedFile } from "@/lib/wiki-files";

interface TreeNode {
  name: string;
  path: string; // 文件: 相对 cwd 的 posix 路径; 目录: ""
  children?: TreeNode[];
}

const MAX_DEPTH = 5;

/**
 * 默认排除的目录名 —— 这些目录几乎不含人工维护的 wiki 文档, 只会让左栏被
 * 几百上千个第三方依赖的 README/LICENSE 撑爆。隐藏目录(.git/.next 等)
 * 已经由 `.` 前缀跳过, 这里只补「不带点的重目录」。
 *
 * 不受项目配置影响: 这些目录不是「不该放行的扩展名」(白名单层面), 而是
 * 「不该出现在 wiki tree 里的目录」 —— 走的是更高一层的过滤, 不暴露开关。
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo", // 已在 . 前缀过滤里, 这里显式兜底, 防止以后去掉隐式过滤后漏掉
  ".cache",
  "target", // rust/maven
  "vendor", // go/php
  ".venv", // python
  "__pycache__",
]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// 功能: 递归扫描目录, 收集放行扩展名的文件为树. 目录仅当含放行文件子代才纳入.
// 关注点: allowed 由调用方从项目配置解析后传入, 不在这里读库.
function walk(
  dirReal: string,
  cwdReal: string,
  depth: number,
  allowed: Set<string>
): TreeNode[] {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirReal, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // 跳过 .git/.next/.env 等, 不受配置影响
    if (EXCLUDED_DIRS.has(e.name)) continue; // 飞书 AO-DEV R76: 默认排除重目录
    const full = path.join(dirReal, e.name);
    if (e.isDirectory()) {
      const children = walk(full, cwdReal, depth + 1, allowed);
      if (children.length > 0) {
        dirs.push({ name: e.name, path: "", children });
      }
    } else if (e.isFile() && isAllowedFile(e.name, allowed)) {
      files.push({ name: e.name, path: toPosix(path.relative(cwdReal, full)) });
    }
  }
  const cmp = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name);
  dirs.sort(cmp);
  files.sort(cmp);
  return [...dirs, ...files];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const project = getProjectById(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 功能: 解析文件树 cwd. ?version= 指定且版本属于本项目时取 version.cwd, fallback project.cwd.
  const versionParam = request.nextUrl.searchParams.get("version");
  const version = versionParam ? getVersionById(versionParam, userId) : null;
  const cwd = version && version.project_id === id ? (version.cwd || project.cwd) : project.cwd;
  if (!cwd) return NextResponse.json({ tree: [] });
  let cwdReal: string;
  try {
    cwdReal = fs.realpathSync(cwd);
  } catch {
    return NextResponse.json({ tree: [] });
  }
  const tree = walk(cwdReal, cwdReal, 1, allowedExtensions(project.wiki_extra_extensions));
  return NextResponse.json({ tree });
}
