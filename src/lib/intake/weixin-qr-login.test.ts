// 微信扫码登录状态机单测 (D3, docs/plans/channel-qr-bind.md).
// 覆盖: createLoginSession (取 QR + SVG 生成 + login_id) / pollLoginStatus
//   pending-scanned-success 迁移 + success 自动建 channel 行 (secret JSON 加密) /
//   expired 清会话 / 跨 owner 拒绝 / login_id 不存在归 expired.

// 本仓 TS 5.0.2 无 Response.json 静态方法 (deploy log 前科), 测试 helper 统一构造
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "../db/index";
import { createProject } from "../db/projects";
import { listChannelConfigs } from "../db/channel-configs";

// QRCode.toString 在 node 环境真跑 (纯 JS 库, 无需 mock); 只 mock iLink fetch.
function stubIlinkQr(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/get_bot_qrcode")) {
        return jsonResponse({
          qrcode: "qr-code-1",
          qrcode_img_content: "https://liteapp.weixin.qq.com/q/abc?qrcode=qr-code-1&bot_type=3",
          ret: 0,
        });
      }
      if (u.includes("/get_qrcode_status")) {
        // 由用例动态改 fetch (stubGlobal 再覆盖)
        return jsonResponse({ status: 0 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

describe("weixin qr-login 状态机", () => {
  let tmpDir: string;
  let ownerId: string;
  let otherOwnerId: string;
  let projectId: string;
  let mod: typeof import("./weixin-qr-login");

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-weixin-qr-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();

    ownerId = uuidv4();
    otherOwnerId = uuidv4();
    for (const id of [ownerId, otherOwnerId]) {
      getDb()
        .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
        .run(id, `${id}@example.com`, "x", "user");
    }
    projectId = createProject({ name: "weixin-qr-test", ownerId }).id;

    stubIlinkQr();
    mod = await import("./weixin-qr-login");
    mod._resetWeixinLoginForTest();
  });

  afterEach(() => {
    closeDb();
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ORCHESTRATOR_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createLoginSession: 返回 login_id + SVG (编码 liteapp URL 非 qrcode 码值)", async () => {
    const s = await mod.createLoginSession({ owner_id: ownerId, bound_project_id: projectId });
    expect(s.login_id).toMatch(/[0-9a-f-]{36}/);
    expect(s.qr_svg).toContain("<svg");
    expect(s.qr_url).toContain("liteapp.weixin.qq.com");
    expect(s.qr_url).not.toBe("qr-code-1");
  });

  it("pending → scanned → success: success 自动建 weixin 渠道行 (secret JSON)", async () => {
    const s = await mod.createLoginSession({ owner_id: ownerId, bound_project_id: projectId });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 0 })));
    expect((await mod.pollLoginStatus(s.login_id, ownerId)).status).toBe("pending");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 1 })));
    expect((await mod.pollLoginStatus(s.login_id, ownerId)).status).toBe("scanned");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: 2, bot_token: "tok-9", ilink_bot_id: "bot-12345678" })),
    );
    const done = await mod.pollLoginStatus(s.login_id, ownerId);
    expect(done.status).toBe("success");

    // channel 行落库: 名字 = weixin-iLink-<botId 前 8>, secret = 加密 JSON
    const rows = listChannelConfigs().filter((c) => c.channel === "weixin");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("weixin-iLink-bot-1234");
    expect(JSON.parse(rows[0].secret!)).toEqual({ bot_token: "tok-9", ilink_bot_id: "bot-12345678" });
    expect(rows[0].bound_project_id).toBe(projectId);
    expect(rows[0].bind_code).toMatch(/^[A-Z2-9]{8}$/);

    // 会话已消费: 再查同一 login_id → expired
    expect((await mod.pollLoginStatus(s.login_id, ownerId)).status).toBe("expired");
  });

  it("iLink expired: 会话清掉 + 返回 expired", async () => {
    const s = await mod.createLoginSession({ owner_id: ownerId, bound_project_id: projectId });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 4 })));
    expect((await mod.pollLoginStatus(s.login_id, ownerId)).status).toBe("expired");
    expect(listChannelConfigs().filter((c) => c.channel === "weixin")).toHaveLength(0);
  });

  it("跨 owner 查询拒判 expired (no existence leak)", async () => {
    const s = await mod.createLoginSession({ owner_id: ownerId, bound_project_id: projectId });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 0 })));
    const r = await mod.pollLoginStatus(s.login_id, otherOwnerId);
    expect(r.status).toBe("expired");
    // 真 owner 的会话不被动
    expect((await mod.pollLoginStatus(s.login_id, ownerId)).status).toBe("pending");
  });

  it("login_id 不存在 → expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 0 })));
    expect((await mod.pollLoginStatus("no-such-id", ownerId)).status).toBe("expired");
  });

  it("挂起超时 (TimeoutError) 归 pending, 会话保留可继续轮询", async () => {
    const s = await mod.createLoginSession({ owner_id: ownerId, bound_project_id: projectId });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("timeout");
        e.name = "TimeoutError";
        throw e;
      }),
    );
    expect((await mod.pollLoginStatus(s.login_id, ownerId)).status).toBe("pending");
    // 恢复后 success 照常走通
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: 2, bot_token: "t", ilink_bot_id: "b" })),
    );
    expect((await mod.pollLoginStatus(s.login_id, ownerId)).status).toBe("success");
  });
});
