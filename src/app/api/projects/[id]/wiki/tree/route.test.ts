// GET /api/projects/[id]/wiki/tree 集成测试.
//
// 关注点 (飞书 AO-DEV R76):
//  - 默认深度 5 (GDM 等深层项目能读到 R6 这种深嵌套文档).
//  - 默认排除重目录 (node_modules / dist / build / coverage / target / ...),
//    即便它们子树里有 README.md 也不出现在 wiki 左栏.
//  - 安全防线 (realpath 锁 cwd + 隐藏文件排除) 不在本测试覆盖, 已在
//    wiki-file-types.test.ts 里有专门的 36 条断言.
//
// 设计说明:
//  - 测试用临时 cwd + 临时 SQLite, 完全隔离.
//  - 通过调用 route 拿到 JSON 树, 断言形状 (depth + exclusion + allowed).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db";
import { createProject } from "@/lib/db/projects";
import { GET as treeGet } from "./route";

interface TreeDir {
  name: string;
  path: "";
  children: TreeNode[];
}
interface TreeFile {
  name: string;
  path: string;
}
type TreeNode = TreeDir | TreeFile;

let tmpDir: string;
let userId: string;
let cwdRoot: string;
let projectId: string;

function writeFile(rel: string, content: string = "# x") {
  const full = path.join(cwdRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function mkDir(rel: string) {
  fs.mkdirSync(path.join(cwdRoot, rel), { recursive: true });
}

// 在返回的 tree 里按 path 找到节点 (路径是相对 cwd 的 posix). 目录节点的 path 是 "",
// 这里用 name + posix 路径去匹配, 匹配到目录返回目录节点, 匹配到文件返回文件节点.
function findByPath(nodes: TreeNode[], p: string): TreeNode | undefined {
  const segs = p.split("/");
  let cur: TreeNode[] = nodes;
  let node: TreeNode | undefined;
  for (let i = 0; i < segs.length; i++) {
    const target = segs[i];
    node = cur.find((n) => n.name === target);
    if (!node) return undefined;
    if (i < segs.length - 1) {
      if (!("children" in node) || !node.children) return undefined;
      cur = node.children;
    }
  }
  return node;
}

function dirByName(nodes: TreeNode[], name: string): TreeDir | undefined {
  for (const n of nodes) {
    if ("children" in n && n.name === name) return n;
  }
  return undefined;
}

async function callTree(asUserId: string | null = userId): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (asUserId) headers["x-user-id"] = asUserId;
  const req = new NextRequest(`http://localhost/api/projects/${projectId}/wiki/tree`, {
    method: "GET",
    headers,
  });
  const res = await treeGet(req as any, { params: Promise.resolve({ id: projectId }) });
  return {
    status: res.status,
    json: await res.json(),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wiki-tree-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "admin");
  cwdRoot = fs.mkdtempSync(path.join(tmpDir, "cwd-"));
  const project = createProject({ name: "wiki-tree", ownerId: userId, cwd: cwdRoot });
  projectId = project.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// 默认深度: 飞书 AO-DEV R76 (原 3 -> 5)
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/projects/[id]/wiki/tree — 深度", () => {
  it("深度 5 内的 .md 全部出现", async () => {
    // MAX_DEPTH=5 时, walk 入参 depth 5 处理的是 4 层子目录 (d1/d2/d3/d4),
    // 文件位于 4 层子目录之下仍然可见. 5 层子目录 (d1/d2/d3/d4/d5) 才被截断.
    writeFile("a.md");
    writeFile("d1/d2/d3/d4/deep.md");
    const r = await callTree();
    expect(r.status).toBe(200);
    expect(findByPath(r.json.tree, "a.md")).toBeDefined();
    expect(findByPath(r.json.tree, "d1/d2/d3/d4/deep.md")).toBeDefined();
  });

  it("深度 6 的 .md 被截断 (d5 这层及更深全部不出现)", async () => {
    // 顶端放 sentinel.md 让根目录可读 (walk 语义是「目录仅当含放行文件子代才
    // 纳入」). 然后 d1/d2/d3/d4/d5/too-deep.md 验证 d5 这一层被截断:
    // walk(d5, depth=6) 直接返回 [], d5 没有放行后代, 整条 d2/d3/d4/d5 链
    // 都因为空目录被裁掉, 不出现在树里.
    writeFile("sentinel.md");
    writeFile("d1/d2/d3/d4/d5/too-deep.md");
    const r = await callTree();
    expect(r.status).toBe(200);
    expect(findByPath(r.json.tree, "sentinel.md")).toBeDefined();
    expect(findByPath(r.json.tree, "d1/d2/d3/d4/d5/too-deep.md")).toBeUndefined();
    // 整条 d1/d2/d3/d4/d5 链因为没有放行后代被裁掉, 不该出现任何一段.
    const treeStr = JSON.stringify(r.json.tree);
    expect(treeStr).not.toContain("too-deep");
    expect(treeStr).not.toContain("d5");
    expect(treeStr).not.toContain("d4");
    expect(treeStr).not.toContain("d3");
    expect(treeStr).not.toContain("d2");
  });

  it("深度 5 边界值: 第 5 层文件仍可见 (depth=5 是闭区间, 不是 >5)", async () => {
    // walk 入参 depth=5 处理的是 4 层子目录 (L1/L2/L3/L4), 文件在 4 层子目录下
    // 仍可见. 这条断言保护边界值不会被某次重构改成 >= 拦截 depth=5.
    writeFile("L1/L2/L3/L4/boundary.md");
    const r = await callTree();
    expect(findByPath(r.json.tree, "L1/L2/L3/L4/boundary.md")).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 默认排除目录: 飞书 AO-DEV R76
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/projects/[id]/wiki/tree — 默认排除重目录", () => {
  const excludedDirs = [
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".cache",
    "target",
    "vendor",
    ".venv",
    "__pycache__",
  ];

  for (const dir of excludedDirs) {
    it(`排除 ${dir}/ (即使里面有 README.md)`, async () => {
      writeFile(`${dir}/README.md`, "noise");
      writeFile(`keep.md`);
      const r = await callTree();
      expect(r.status).toBe(200);
      expect(findByPath(r.json.tree, "keep.md")).toBeDefined();
      expect(findByPath(r.json.tree, `${dir}/README.md`)).toBeUndefined();
      // 目录节点本身也不该出现
      expect(dirByName(r.json.tree, dir)).toBeUndefined();
    });
  }

  it("隐藏目录 (.) 仍被排除 (与新增的 EXCLUDED_DIRS 互不干扰)", async () => {
    writeFile(".git/HEAD");
    writeFile(".next/cache/x.md");
    writeFile("visible.md");
    const r = await callTree();
    expect(findByPath(r.json.tree, "visible.md")).toBeDefined();
    expect(findByPath(r.json.tree, ".git/HEAD")).toBeUndefined();
    expect(findByPath(r.json.tree, ".next/cache/x.md")).toBeUndefined();
  });

  it("白名单扩展名之外的文件仍被忽略 (沿用 wiki-files.ts 既有规则)", async () => {
    writeFile("app.ts");
    writeFile("ok.md");
    const r = await callTree();
    // 默认未配 wiki_extra_extensions, 放行集合 = {md}
    expect(findByPath(r.json.tree, "ok.md")).toBeDefined();
    expect(findByPath(r.json.tree, "app.ts")).toBeUndefined();
  });

  it("混合: node_modules 嵌套 + 真实文档同时存在时, 真实文档可见", async () => {
    writeFile("node_modules/some-pkg/README.md");
    writeFile("src/components/Button/Button.tsx");
    writeFile("docs/guide.md");
    const r = await callTree();
    expect(findByPath(r.json.tree, "docs/guide.md")).toBeDefined();
    expect(findByPath(r.json.tree, "node_modules/some-pkg/README.md")).toBeUndefined();
    // src/components/Button/Button.tsx 不在默认放行扩展名里, 也不该出现
    expect(findByPath(r.json.tree, "src/components/Button/Button.tsx")).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 安全 + auth (快速冒烟, 完整覆盖在 wiki-file-types.test.ts)
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/projects/[id]/wiki/tree — auth/兜底", () => {
  it("401: 无 x-user-id", async () => {
    writeFile("a.md");
    const r = await callTree(null);
    expect(r.status).toBe(401);
  });

  it("空 cwd: 返回空 tree 不报错", async () => {
    // 重置 cwdRoot 为空目录
    fs.rmSync(cwdRoot, { recursive: true, force: true });
    fs.mkdirSync(cwdRoot, { recursive: true });
    const r = await callTree();
    expect(r.status).toBe(200);
    expect(r.json.tree).toEqual([]);
  });
});
