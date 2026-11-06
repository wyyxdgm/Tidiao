// GET /api/projects/[id]/wiki?path=...&download=1 集成测试.
//
// 关注点:
//  - ?download=1 走的是 raw file response(200 + Content-Disposition: attachment),
//    不是 JSON 视图. 浏览器只要看到 attachment 头就会自动保存, 按 Content-Type
//    决定打开方式.
//  - 安全路径与 JSON 路径共享同一个 safeResolve —— 隐藏文件 / 路径穿越 / 未配置
//    扩展名 已在前面被拒, 这里只关心 download 自身的语义. 因此测试不重复那些
//    safeResolve 案例(在 wiki-file-types.test.ts 里有 36 条).
//  - 始终返回原文件(含 frontmatter); 不应被处理成"去掉 frontmatter 的 body"形式.
//  - 非 md 仍卡 1 MiB 上限; md 不卡(历史行为).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db";
import { createProject, getProjectById, updateProject } from "@/lib/db/projects";
import { contentTypeFor, MAX_NON_MD_BYTES } from "@/lib/wiki-files";
import { GET as wikiGet } from "./route";

let tmpDir: string;
let userId: string;
let cwdRoot: string;
let projectId: string;

function writeFile(rel: string, content: string | Buffer) {
  const full = path.join(cwdRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function callWiki(
  qs: string,
  asUserId: string | null = userId
): Promise<{ status: number; headers: Headers; body: Buffer | string; json: any | null }> {
  const headers: Record<string, string> = {};
  if (asUserId) headers["x-user-id"] = asUserId;
  const req = new NextRequest(`http://localhost/api/projects/${projectId}/wiki?${qs}`, {
    method: "GET",
    headers,
  });
  const res = await wikiGet(req as any, { params: Promise.resolve({ id: projectId }) });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "";
  const isJson = ct.startsWith("application/json");
  return {
    status: res.status,
    headers: res.headers,
    body: buf,
    json: isJson ? JSON.parse(buf.toString("utf8")) : null,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wiki-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "admin");
  cwdRoot = fs.mkdtempSync(path.join(tmpDir, "cwd-"));
  const project = createProject({ name: "wiki-dl", ownerId: userId, cwd: cwdRoot });
  projectId = project.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// contentTypeFor (纯函数)
// ───────────────────────────────────────────────────────────────────────────

describe("contentTypeFor", () => {
  it("已知文本类带 charset=utf-8", () => {
    expect(contentTypeFor("md")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeFor("txt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("csv")).toBe("text/csv; charset=utf-8");
    expect(contentTypeFor("yaml")).toBe("application/yaml; charset=utf-8");
  });

  it("代码类走对应 mime", () => {
    expect(contentTypeFor("ts")).toBe("text/typescript; charset=utf-8");
    expect(contentTypeFor("tsx")).toBe("text/typescript; charset=utf-8");
    expect(contentTypeFor("js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("py")).toBe("text/x-python; charset=utf-8");
    expect(contentTypeFor("sh")).toBe("text/x-shellscript; charset=utf-8");
  });

  it("未知扩展名 -> octet-stream (浏览器照样下载, 不假装懂)", () => {
    expect(contentTypeFor("xyz")).toBe("application/octet-stream");
    expect(contentTypeFor("weird-extension")).toBe("application/octet-stream");
  });

  it("空串 -> octet-stream (无扩展名文件也走下载)", () => {
    expect(contentTypeFor("")).toBe("application/octet-stream");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 默认 JSON 路径 (download 行为不污染默认)
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/projects/[id]/wiki (默认 JSON 路径)", () => {
  it("无 download 参数 -> 返回 JSON + kind/markdown/links", async () => {
    writeFile("INDEX.md", "---\ntitle: t\n---\n# body");
    const r = await callWiki("path=INDEX.md");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.json.kind).toBe("markdown");
    expect(r.json.markdown).toBe("# body");
    expect(r.json.title).toBe("t");
    expect(r.json.exists).toBe(true);
  });

  it("401: 无 x-user-id", async () => {
    writeFile("INDEX.md", "x");
    const r = await callWiki("path=INDEX.md", null);
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("unauthorized");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ?download=1 路径
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/projects/[id]/wiki?download=1", () => {
  it("markdown: 返回原始 bytes + Content-Disposition + 正确 Content-Type", async () => {
    const content = "---\ntitle: foo\n---\n# body\n\nhello";
    writeFile("INDEX.md", content);
    const r = await callWiki("path=INDEX.md&download=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const disp = r.headers.get("content-disposition") || "";
    expect(disp).toContain("attachment");
    expect(disp).toContain('filename="INDEX.md"');
    // 关键: 含 frontmatter 的原文, 不被剥成 body
    expect(r.body.toString("utf8")).toBe(content);
  });

  it("非 md (json): 配了扩展名后能下载, Content-Type 按扩展名", async () => {
    updateProject(projectId, { wiki_extra_extensions: ["json"] });
    writeFile("data.json", '{"a":1}');
    const r = await callWiki("path=data.json&download=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.body.toString("utf8")).toBe('{"a":1}');
  });

  it("中文文件名: 双 filename 一份纯 ASCII (legacy) + UTF-8 编码 (RFC 5987)", async () => {
    // 放行 .md 是默认就有的, 不用改项目配置; 文件名含中文/空格也能正常走 URL.
    writeFile("实盘组合回撤.md", "中文文件名 body");
    const r = await callWiki(`path=${encodeURIComponent("实盘组合回撤.md")}&download=1`);
    expect(r.status).toBe(200);
    const disp = r.headers.get("content-disposition") || "";
    expect(disp).toContain("attachment");
    // RFC 5987 filename* = UTF-8'' + percent-encoded 原文
    expect(disp).toContain("filename*=UTF-8''");
    expect(disp).toContain(encodeURIComponent("实盘组合回撤.md"));
    // legacy filename="..." 必须是 ASCII (Headers value 是 byte string, 不能含
    // 中文); 中文字符应被替换为 '_', 长度不会撞 quota. 完整原文仍由 filename* 承担.
    const legacyMatch = disp.match(/filename="([^"]*)"/);
    expect(legacyMatch).not.toBeNull();
    expect(legacyMatch![1]).toMatch(/^[\x20-\x7E]+$/);
    expect(r.body.toString("utf8")).toBe("中文文件名 body");
  });

  it("Content-Length 与 body 字节数一致", async () => {
    writeFile("INDEX.md", "x".repeat(1234));
    const r = await callWiki("path=INDEX.md&download=1");
    expect(r.status).toBe(200);
    expect(Number(r.headers.get("content-length"))).toBe(r.body.length);
  });

  it("非 md 超过 1 MiB -> 413 + too-large JSON (不读进内存)", async () => {
    updateProject(projectId, { wiki_extra_extensions: ["json"] });
    const big = Buffer.alloc(MAX_NON_MD_BYTES + 1, 0x61); // 1 MiB + 1
    writeFile("big.json", big);
    const r = await callWiki("path=big.json&download=1");
    expect(r.status).toBe(413);
    expect(r.json.reason).toBe("too-large");
    expect(r.json.size).toBe(MAX_NON_MD_BYTES + 1);
    expect(r.json.limit).toBe(MAX_NON_MD_BYTES);
  });

  it("🔴 路径穿越/隐藏文件: 走不到 download 分支 (safeResolve 拦在前面)", async () => {
    // ../ 逃出 cwd + 隐藏文件 + 未配置扩展名 — 任何一种都返回 not-found JSON,
    // 绝不会变成 raw file response 把不该看的文件吐出来.
    writeFile("secret.md", "should never appear");
    for (const evil of [
      "../secret.md",
      ".hidden.md",
      "docs/../../secret.md",
    ]) {
      const r = await callWiki(`path=${encodeURIComponent(evil)}&download=1`);
      expect(r.status).toBe(200);
      // 要么是 not-found JSON, 要么 — 反正不能是 raw file response 含原文
      const ct = r.headers.get("content-type") || "";
      if (ct.startsWith("application/json")) {
        expect(r.json.reason).toBe("not-found");
      } else {
        // 万一走到 raw 路径, body 不能含 "should never appear"
        expect(r.body.toString("utf8")).not.toContain("should never appear");
      }
    }
  });

  it("未配扩展名 + 下载 .json -> not-found JSON (白名单先于 download)", async () => {
    writeFile("secret.json", '{"x":1}');
    const r = await callWiki("path=secret.json&download=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.json.reason).toBe("not-found");
  });
});
