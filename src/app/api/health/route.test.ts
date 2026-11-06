// /api/health 存活探针契约 (R185): 200 + {ok:true} + no-store.
import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("返回 200 { ok: true }", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("带 Cache-Control: no-store (呼吸点轮询不缓存)", async () => {
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
