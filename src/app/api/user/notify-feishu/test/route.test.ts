// POST /api/user/notify-feishu/test 集成测试 (draft 测试支持).
//
// 覆盖:
//   1. 鉴权: 401 / 404 (与原端点行为一致)
//   2. saved + draft 都空 → { sent:false, reason } (旧行为)
//   3. saved 有 + draft 无 → mock fetch 收到 saved URL (旧行为)
//   4. saved 空 + draft 合法 → mock fetch 收到 draft URL (新增)
//   5. saved 有 + draft 合法 → draft 优先 (新增)
//   6. draft 非法 → 400 (新增)
//   7. mock fetch 失败 → { sent:false } 不 5xx
//   8. masked_url 用 draft 算 (新增)
//
// 关注点:
//   - mock globalThis.fetch (同 notify/route.test.ts).
//   - 不真发任何东西.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { POST } from "./route";
import { closeDb, getDb } from "@/lib/db";
import { createUser, setUserFeishuWebhook } from "@/lib/db/users";

const VALID_FEISHU_A =
  "https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaaaaaaaaaaaaaa";
const VALID_FEISHU_B =
  "https://open.feishu.cn/open-apis/bot/v2/hook/bbbbbbbbbbbbbbbbbbbb";

let tmpDir: string;
let userId: string;

async function callTest(
  body: Record<string, unknown> | null,
  opts: { userId?: string | null; rawBody?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.userId !== null) {
    headers["x-user-id"] = opts.userId ?? userId;
  }
  if (body !== null || opts.rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const req = new Request("http://localhost/api/user/notify-feishu/test", {
    method: "POST",
    headers,
    body:
      opts.rawBody !== undefined
        ? opts.rawBody
        : body !== null
        ? JSON.stringify(body)
        : undefined,
  });
  const res = await POST(req as any);
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-feishu-test-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  const u = await createUser("test@example.test", "pw");
  userId = u.id;

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"StatusCode":0,"msg":"success"}',
    })
  );
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("POST /api/user/notify-feishu/test 鉴权", () => {
  it("无 x-user-id → 401", async () => {
    const { status, body } = await callTest(null, { userId: null });
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("x-user-id 不存在 → 404", async () => {
    const { status, body } = await callTest(null, {
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(status).toBe(404);
    expect(body.error).toBe("user not found");
  });
});

describe("POST /api/user/notify-feishu/test 旧行为 (无 draft)", () => {
  it("saved 空 + body 空 → 200 + sent:false (reason)", async () => {
    const { status, body } = await callTest({});
    expect(status).toBe(200);
    expect(body.sent).toBe(false);
    expect(body.reason).toMatch(/未配置飞书 webhook URL/);
  });

  it("saved 有 + body 空 → 测 saved", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU_A);
    const { status, body } = await callTest({});
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.masked_url).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/****aaaa"
    );
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(VALID_FEISHU_A);
  });

  it("body 不是合法 JSON → 当作无 draft, 走 saved 路径", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU_A);
    const { status, body } = await callTest(null, { rawBody: "{not json" });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
  });
});

describe("POST /api/user/notify-feishu/test draft 测试 (新增)", () => {
  it("saved 空 + draft 合法 → 测 draft", async () => {
    const { status, body } = await callTest({ webhook_url: VALID_FEISHU_B });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.masked_url).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/****bbbb"
    );
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(VALID_FEISHU_B);
  });

  it("saved 有 + draft 合法 → draft 优先", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU_A);
    const { status, body } = await callTest({ webhook_url: VALID_FEISHU_B });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.masked_url).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/****bbbb"
    );
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(VALID_FEISHU_B);
  });

  it("saved 有 + draft 空字符串 → 走 saved (空 draft 视为未传)", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU_A);
    const { status, body } = await callTest({ webhook_url: "   " });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(VALID_FEISHU_A);
  });

  it("draft 非法 (非 feishu 域名) → 400", async () => {
    const { status, body } = await callTest({
      webhook_url: "https://evil.com/hook/xxx",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid webhook_url format");
  });

  it("draft 非法 (feishu 但 token 太短) → 400", async () => {
    const { status, body } = await callTest({
      webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/short",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid webhook_url format");
  });

  it("draft 合法但 mock fetch 失败 → 200 + sent:false 不 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      })
    );
    const { status, body } = await callTest({ webhook_url: VALID_FEISHU_B });
    expect(status).toBe(200);
    expect(body.sent).toBe(false);
  });
});