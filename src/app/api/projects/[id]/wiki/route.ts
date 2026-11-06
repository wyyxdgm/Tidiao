// GET /api/projects/[id]/wiki?path=INDEX.md[&download=1]
// 读 version.cwd||project.cwd 下的 wiki 文件, 默认返回正文 + frontmatter links JSON;
// ?download=1 时返回原始文件内容(带 frontmatter) + Content-Disposition: attachment,
// 让浏览器直接下载原文(而非 JSON 视图), 用于把 md/资料文件保存到本地.
// 关注点: realpath 锁死 cwd 防穿越; 放行扩展名由项目配置决定(默认只 .md, 见
//        lib/wiki-files.ts); 隐藏路径段一律拒(不受配置影响); 非 md 读文件路径有 1 MiB
//        上限(json/text 路径共用, 见 MAX_NON_MD_BYTES); frontmatter/正文分离只对 md
//        JSON 路径做; download 路径**始终返回原文件**(不要剥 frontmatter, 用户要的是
//        原文); frontmatter yaml 解析降级(解析失败不阻断).

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getProjectById } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import {
  allowedExtensions,
  contentTypeFor,
  extOf,
  isMarkdown,
  MAX_NON_MD_BYTES,
} from "@/lib/wiki-files";
import { safeResolve } from "@/lib/wiki-resolve";

interface WikiLink {
  label: string;
  url: string;
}

// 功能: 从 markdown 内容分离 frontmatter 与正文, 返回 {fm, body}.
function splitFrontmatter(content: string): { fm: string | null; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: null, body: content };
  return { fm: m[1], body: m[2] };
}

// 功能: 解析 frontmatter yaml, 提取 links 数组 (label+url) 和 title. 解析失败降级为空.
function parseFrontmatter(fm: string | null): { links: WikiLink[]; title: string | null } {
  if (!fm) return { links: [], title: null };
  let parsed: unknown;
  try {
    parsed = YAML.parse(fm);
  } catch {
    return { links: [], title: null };
  }
  if (!parsed || typeof parsed !== "object") return { links: [], title: null };
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title : null;
  let links: WikiLink[] = [];
  if (Array.isArray(obj.links)) {
    links = obj.links
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .filter((l) => typeof l.label === "string" && typeof l.url === "string")
      .map((l) => ({ label: String(l.label), url: String(l.url) }));
  }
  return { links, title };
}

// safeResolve 已移到 @/lib/wiki-resolve —— 那里是唯一实现, 测试直接 import 它。
// 🔴 别在这里(或测试里)再抄一份: 上一版测试抄了一份复刻, 导致突变真实防护时测试
// 全绿(假绿), 见 wiki-resolve.ts 顶部注释。

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

  // 功能: 解析 wiki 内容 cwd. ?version= 指定且版本属于本项目时取 version.cwd, fallback project.cwd;
  //       无 version 时用 project.cwd (默认版本由前端解析 current_version_id 后传入).
  const versionParam = request.nextUrl.searchParams.get("version");
  const version = versionParam ? getVersionById(versionParam, userId) : null;
  const cwd = version && version.project_id === id ? (version.cwd || project.cwd) : project.cwd;
  if (!cwd) {
    return NextResponse.json({
      path: null, markdown: null, kind: "markdown", links: [], title: null,
      exists: false, reason: "no-cwd",
    });
  }

  let cwdReal: string;
  try {
    cwdReal = fs.realpathSync(cwd);
  } catch {
    return NextResponse.json({
      path: null, markdown: null, kind: "markdown", links: [], title: null,
      exists: false, reason: "no-cwd",
    });
  }

  const rel = request.nextUrl.searchParams.get("path")?.trim() || "INDEX.md";
  // 默认入口 INDEX.md 不存在则 fallback CLAUDE.md; 显式 path 不 fallback.
  const candidates = rel === "INDEX.md" ? ["INDEX.md", "CLAUDE.md"] : [rel];
  const allowed = allowedExtensions(project.wiki_extra_extensions);

  let resolved: { chosen: string; fullReal: string } | null = null;
  for (const c of candidates) {
    resolved = safeResolve(cwdReal, c, allowed);
    if (resolved) break;
  }
  if (!resolved) {
    return NextResponse.json({
      path: rel, markdown: null, kind: "markdown", links: [], title: null,
      exists: false, reason: "not-found",
    });
  }

  // ?download=1: 直接返回原始文件内容 + Content-Disposition: attachment, 让浏览器
  // 把 wiki 文件存到本地(常用: 把 md 笔记/资料文件下载回本地编辑). **始终返回原文件**,
  // 不剥 frontmatter(json 路径才有 frontmatter 分离) —— 用户要的是原文可见的拷贝.
  // 安全: 走的是同一个 safeResolve, 扩展名已在白名单 + 路径已锁在 cwd 内, 这里只
  // 是换个 output 格式, 不另开一道闸门. 非 md 仍卡 1 MiB 上限(与 JSON 路径同步, 防
  // 误把数据文件加进 wiki_extra_extensions); md 不卡(bool 路径历史上就不卡)。
  if (request.nextUrl.searchParams.get("download") === "1") {
    const fullReal = resolved.fullReal;
    const isMd = isMarkdown(fullReal);
    const size = fs.statSync(fullReal).size;
    if (!isMd && size > MAX_NON_MD_BYTES) {
      // 与 JSON 路径一致: 超大文件给前端一个明确的 too-large 提示, 不要让 readFileSync
      // 读进内存.
      return NextResponse.json({
        path: resolved.chosen, markdown: null, kind: "text", links: [], title: null,
        exists: false, reason: "too-large",
        size, limit: MAX_NON_MD_BYTES,
      }, { status: 413 });
    }
    const buf = fs.readFileSync(fullReal);
    const filename = path.basename(fullReal);
    // RFC 5987 双 filename: 老代理/工具读 filename="..." (必须 ASCII), 现代浏览器
    // 读 filename*=UTF-8''... (百分号编码, 完整 UTF-8). Headers 要求 value 是 byte
    // string, 所以 legacy 部分强制 ASCII 转写(中文/不可打印字符 → '_').
    const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/[\r\n"]/g, "_");
    const encoded = encodeURIComponent(filename);
    const headers = new Headers({
      "Content-Type": contentTypeFor(extOf(filename)),
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
      "Content-Length": String(buf.length),
    });
    return new NextResponse(buf, { headers });
  }

  // 非 md 走纯文本路径: 不做 frontmatter 分离(json 开头的 --- 不是 frontmatter),
  // 且卡 1 MiB 上限 —— readFileSync 本身无上限, 放开 .json/.csv 后几十 MB 的导出
  // 文件会把服务端内存和浏览器一起打死. md 保持无上限(存量行为零变化).
  const md = isMarkdown(resolved.fullReal);
  if (!md) {
    const size = fs.statSync(resolved.fullReal).size;
    if (size > MAX_NON_MD_BYTES) {
      return NextResponse.json({
        path: resolved.chosen, markdown: null, kind: "text", links: [], title: null,
        exists: false, reason: "too-large",
        size, limit: MAX_NON_MD_BYTES,
      });
    }
    const raw = fs.readFileSync(resolved.fullReal, "utf8");
    return NextResponse.json({
      path: resolved.chosen,
      markdown: raw, // 字段名沿用 markdown 以免改动前端所有引用; kind 决定怎么渲染
      kind: "text",
      ext: extOf(path.basename(resolved.fullReal)),
      links: [],
      title: null,
      exists: true,
    });
  }

  const content = fs.readFileSync(resolved.fullReal, "utf8");
  const { fm, body } = splitFrontmatter(content);
  const { links, title } = parseFrontmatter(fm);

  return NextResponse.json({
    path: resolved.chosen, markdown: body, kind: "markdown", links, title, exists: true,
  });
}
