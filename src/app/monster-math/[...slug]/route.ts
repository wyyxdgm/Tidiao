// /monster-math/* 静态媒体服务: 流式读取本机 /Users/user/www/monster-math 下的当日候选
// (视频/封面/页面), 供 mac.example.com 外部直链访问 (middleware 已放行该前缀).
// 关注点: 1) 路径遍历防护 —— resolve 后必须仍以 ROOT 开头; 2) 支持 Range (iOS Safari
// 播 mp4 需要 206); 3) 文件运行时从磁盘读, 新增候选无需 rebuild.
import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { Readable } from "stream";

const ROOT = "/Users/user/www/monster-math";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
};

// 功能: 把 /monster-math/<...> 映射到 ROOT 下的真实文件, 支持 Range, 流式返回
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  let full = path.resolve(ROOT, ...slug);
  if (!full.startsWith(ROOT + path.sep)) {
    return new Response("forbidden", { status: 403 });
  }
  if (!existsSync(full)) {
    return new Response("not found", { status: 404 });
  }
  if (statSync(full).isDirectory()) {
    full = path.join(full, "index.html");   // 目录 URL → 当日页面
    if (!existsSync(full)) return new Response("not found", { status: 404 });
  }
  const size = statSync(full).size;
  const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range");
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? parseInt(m[1]) : 0;
      const end = m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      const stream = Readable.toWeb(
        createReadStream(full, { start, end })
      ) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }
  }
  const stream = Readable.toWeb(createReadStream(full)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    },
  });
}
