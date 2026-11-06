// GET /api/channels/[id]/bind-qr 测试 (docs/plans/channel-qr-bind.md D1).
//
// 覆盖: telegram 深链 (mock getMe) / getMe 失败 BOT_UNREACHABLE / feishu 文本命令 /
//   lark 域名 hint / wecom null QR / owner 隔离 404 / INTAKE_CHANNELS 含 lark.
//
// 关注点: fetch 全局桩化拦 getMe (api.telegram.org 国内被墙); 模块级 botUsername
//   缓存靠 vi.resetModules 逐用例重建; db 用临时库 (channel-configs.test.ts 同模式).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createChannelConfig } from "@/lib/db/channel-configs";
import { INTAKE_CHANNELS } from "@/lib/db/intake-threads";

let tmpDir: string;
let ownerId: string;
let otherOwnerId: string;
let projectId: string;
let GET: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

function getMeResponse(username: string | null): Record<string, unknown> {
  return username
    ? { ok: true, result: { id: 1, is_bot: true, first_name: "T", username } }
    : { ok: false, error_code: 401, description: "Unauthorized" };
}

function req(id: string, userId: string): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/channels/${id}/bind-qr`), {
    headers: { "x-user-id": userId },
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-bind-qr-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  otherOwnerId = uuidv4();
  for (const uid of [ownerId, otherOwnerId]) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(uid, `${uid}@example.com`, "x", "user");
  }
  projectId = createProject({ name: "bind-qr-proj", ownerId }).id;

  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => getMeResponse("my_test_bot"),
  }));
  vi.stubGlobal("fetch", fetchMock);

  GET = (await import("./route")).GET;
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  vi.resetModules(); // botUsernameCache 随模块重建, 防跨用例泄漏
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("bind-qr API (D1)", () => {
  it("telegram: QR 内容 = t.me/<bot>?start=<码> 深链, SVG 生成, getMe 恰调一次", async () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      secret: "123:ABC",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const res = await GET(req(cfg.id, ownerId), { params: Promise.resolve({ id: cfg.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.qr_content).toBe(`https://t.me/my_test_bot?start=${cfg.bind_code}`);
    expect(body.copy_text).toBe(body.qr_content);
    expect(body.qr_svg).toMatch(/^<svg/);
    expect(body.hint).toContain("/start");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("api.telegram.org/bot123:ABC/getMe");
  });

  it("telegram: getMe 失败 (token 无效) → 400 BOT_UNREACHABLE, 不产 QR", async () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      secret: "123:BAD",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => getMeResponse(null),
    }));

    const res = await GET(req(cfg.id, ownerId), { params: Promise.resolve({ id: cfg.id }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("BOT_UNREACHABLE");
  });

  it("telegram: 网络失败 → 400 BOT_UNREACHABLE", async () => {
    const cfg = createChannelConfig({
      channel: "telegram",
      name: "bot",
      secret: "123:NET",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    fetchMock.mockRejectedValue(new Error("connect timeout"));

    const res = await GET(req(cfg.id, ownerId), { params: Promise.resolve({ id: cfg.id }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("BOT_UNREACHABLE");
  });

  it("feishu: QR = 纯文本 bind 命令, hint 带 feishu.cn", async () => {
    const cfg = createChannelConfig({
      channel: "feishu",
      name: "feishu-app",
      secret: JSON.stringify({ verificationToken: "t", encryptKey: "k" }),
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const res = await GET(req(cfg.id, ownerId), { params: Promise.resolve({ id: cfg.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.qr_content).toBe(`bind ${cfg.bind_code}`);
    expect(body.copy_text).toBe(`bind ${cfg.bind_code}`);
    expect(body.qr_svg).toMatch(/^<svg/);
    expect(body.hint).toContain("feishu.cn");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lark: 同 feishu 逻辑, hint 带 larksuite.com", async () => {
    const cfg = createChannelConfig({
      channel: "lark",
      name: "lark-app",
      secret: JSON.stringify({ verificationToken: "t", encryptKey: "k" }),
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const res = await GET(req(cfg.id, ownerId), { params: Promise.resolve({ id: cfg.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.qr_content).toBe(`bind ${cfg.bind_code}`);
    expect(body.hint).toContain("larksuite.com");
  });

  it("wecom: qr_content = null (凭据即绑定, 不做假 QR)", async () => {
    const cfg = createChannelConfig({
      channel: "wecom",
      name: "kf",
      secret: "wecom-cred",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const res = await GET(req(cfg.id, ownerId), { params: Promise.resolve({ id: cfg.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.qr_content).toBeNull();
    expect(body.qr_svg).toBeNull();
    expect(body.copy_text).toBeNull();
    expect(body.hint).toContain("无需扫码");
  });

  it("owner 隔离: 跨 owner 取他人渠道 → 404 (no existence leak)", async () => {
    const cfg = createChannelConfig({
      channel: "feishu",
      name: "not-yours",
      secret: JSON.stringify({ verificationToken: "t", encryptKey: "k" }),
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    const res = await GET(req(cfg.id, otherOwnerId), {
      params: Promise.resolve({ id: cfg.id }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("CHANNEL_NOT_FOUND");
  });

  it("INTAKE_CHANNELS 含 lark (D2 枚举)", () => {
    expect(INTAKE_CHANNELS).toContain("lark");
  });
});
