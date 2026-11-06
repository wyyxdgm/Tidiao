// PATCH /api/versions/[id] 测试 —— 聚焦 v512 `enable`（sheetwatch 自动派发开关）。
//
// 为什么只测 enable: feishu_url/sheet 的 PATCH 已有 R49 覆盖, 且本次没动那两条路径。
// enable 是「关掉就不再自动派任务」的止血阀 —— 静默吞字段会让用户以为关掉了、
// sheetwatch 继续派 (2026-09-29 crazygames 一次喷 20 条的直接背景), 所以
// 三个分支都要钉死: 显式 false 落库 / undefined 不动 / 非布尔 400。
//
// 真 SQLite 临时库 + 直接调 handler。脚手架照搬
// src/app/api/maintenance/status/route.test.ts:16-48。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { PATCH } from "./route";
import { closeDb, getDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createVersion, getVersionById } from "@/lib/db/versions";

let tmpDir: string;
let userId: string;
let projectId: string;
let versionId: string;

/** PATCH 请求. body 省略 → 发空 JSON, 对应「不改任何字段」. */
function patchReq(body: Record<string, unknown> | null, uid: string | null = userId) {
  const headers: Record<string, string> = {};
  if (uid) headers["x-user-id"] = uid;
  return new NextRequest(`http://localhost/api/versions/${versionId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

/** 调 PATCH handler. 路由是 async 收 params, 这里包一层免得每条测试都 await params. */
async function callPatch(req: NextRequest) {
  return PATCH(req, { params: Promise.resolve({ id: versionId }) });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-version-patch-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "alice@example.com", "x", "user");

  projectId = createProject({ name: "p1", ownerId: userId }).id;
  versionId = createVersion({
    project_id: projectId,
    name: "v1",
    feishu_url: "https://example.feishu.cn/wiki/abc",
    feishu_sheet: "sheet-A",
  }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
});

describe("PATCH /api/versions/[id] — enable (sheetwatch 开关)", () => {
  it("新建 version 默认 enable=1（老调用方兼容）", () => {
    expect(getVersionById(versionId, userId)!.enable).toBe(1);
  });

  it("createVersion 传 enable:false 落库为 0", () => {
    const v = createVersion({ project_id: projectId, name: "v-off", enable: false });
    expect(getVersionById(v.id, userId)!.enable).toBe(0);
  });

  it("显式 enable:false → 落库 0, 响应回显 0", async () => {
    const res = await callPatch(patchReq({ enable: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version.enable).toBe(0);
    expect(getVersionById(versionId, userId)!.enable).toBe(0);
  });

  it("enable:false 后可再打开回 1（开关双向）", async () => {
    await callPatch(patchReq({ enable: false }));
    const res = await callPatch(patchReq({ enable: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).version.enable).toBe(1);
    expect(getVersionById(versionId, userId)!.enable).toBe(1);
  });

  it("不传 enable → 该列不动（undefined = 不改, 不回落默认值）", async () => {
    await callPatch(patchReq({ enable: false }));
    // 只 PATCH feishu_sheet, enable 必须保持 0 而不是被重置
    const res = await callPatch(patchReq({ feishu_sheet: "sheet-B" }));
    expect(res.status).toBe(200);
    expect(getVersionById(versionId, userId)!.enable).toBe(0);
    expect(getVersionById(versionId, userId)!.feishu_sheet).toBe("sheet-B");
  });

  it("非布尔 enable 返 400 且不写库（0/1/'true' 都拒, 避免 1 静默当真）", async () => {
    for (const bad of [0, 1, "true", null]) {
      const res = await callPatch(patchReq({ enable: bad }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/invalid enable/);
    }
    // 全程没写成功 → 仍是初始 1
    expect(getVersionById(versionId, userId)!.enable).toBe(1);
  });

  it("enable 与 feishu_url 同批 PATCH 都落库", async () => {
    const res = await callPatch(
      patchReq({
        enable: false,
        feishu_url: "https://example.feishu.cn/wiki/xyz",
        feishu_sheet: "sheet-C",
      }),
    );
    expect(res.status).toBe(200);
    const v = getVersionById(versionId, userId)!;
    expect(v.enable).toBe(0);
    expect(v.feishu_url).toBe("https://example.feishu.cn/wiki/xyz");
    expect(v.feishu_sheet).toBe("sheet-C");
  });

  it("缺 x-user-id 返 401, 不泄露 version 存在性", async () => {
    const res = await callPatch(patchReq({ enable: false }, null));
    expect(res.status).toBe(401);
    expect(getVersionById(versionId, userId)!.enable).toBe(1);
  });

  it("非 owner PATCH 返 404（ownership gate 先于写入）", async () => {
    const otherId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(otherId, "bob@example.com", "x", "user");
    const res = await callPatch(patchReq({ enable: false }, otherId));
    expect(res.status).toBe(404);
    expect(getVersionById(versionId, userId)!.enable).toBe(1);
  });
});
