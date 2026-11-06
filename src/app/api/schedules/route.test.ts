// GET /api/schedules 路由层测试 — enabled 状态筛选 (2026-11-02)。
// 覆盖:
//   - ?enabled=true 只返启用 / ?enabled=false 只返停用
//   - 未传 = 不过滤; 非法值（如 "yes"）= 不过滤（与 db 层兜底一致）
//   - owner 隔离在 db 层测试已覆盖（schedules.test.ts），这里不重复

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET } from "./route";

let tmpDir: string;
let userId: string;

function makeReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/schedules${query}`, {
    method: "GET",
    headers: { "content-type": "application/json", "x-user-id": userId },
  });
}

function seedEnabled(name: string, enabled: boolean): void {
  getDb()
    .prepare(
      "INSERT INTO schedules (id, name, exec_type, schedule_type, schedule_expr, next_run, enabled, owner_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"
    )
    .run(uuidv4(), name, "shell", "cron", "0 0 * * *", "2099-01-01T00:00:00Z", enabled ? 1 : 0, userId);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sched-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  userId = uuidv4();
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(userId, `${userId}@example.com`, "x");
  seedEnabled("on-1", true);
  seedEnabled("off-1", false);
  seedEnabled("on-2", true);
});

async function names(query: string): Promise<string[]> {
  const res = await GET(makeReq(query));
  const arr = (await res.json()) as Array<{ name: string }>;
  return arr.map((s) => s.name).sort();
}

describe("GET /api/schedules enabled 筛选", () => {
  it("?enabled=true 只返启用", async () => {
    expect(await names("?enabled=true")).toEqual(["on-1", "on-2"]);
  });

  it("?enabled=false 只返停用", async () => {
    expect(await names("?enabled=false")).toEqual(["off-1"]);
  });

  it("未传 = 不过滤，全部返回", async () => {
    expect(await names("")).toEqual(["off-1", "on-1", "on-2"]);
  });

  it("非法值 = 不过滤（兜成 undefined）", async () => {
    expect(await names("?enabled=yes")).toEqual(["off-1", "on-1", "on-2"]);
  });
});
