// POST /api/runners/[id]/health  ——  admin 手动触发一次 runner 探针.
//
// 关注点:
//  - R1 阶段 runner daemon 不强制 /v1/health 鉴权 (R2 还没上). 我们就用裸
//    HTTP GET 拉一次, 把 JSON 落到 runners.last_health_json, 给前端看.
//  - 5s 超时, 任何网络/超时/非 JSON 都回 400 + 具体原因.
//  - 不更新 status —— status 由 runner 自己的心跳驱动 (在线/心跳/无心跳
//    三段语义比"刚刚收到一次响应"的语义更稳).
//  - 不调 updateRunnerHeartbeat: health 200 不等于 runner 在线, 只是
//    它此刻响应了. 状态决策交给按节奏发出的 heartbeat.

import { NextRequest, NextResponse } from "next/server";
import { getRunnerById, updateRunnerHealth } from "@/lib/db/runners";

function isAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

const HEALTH_TIMEOUT_MS = 5000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  const { id } = await params;
  const runner = getRunnerById(id);
  if (!runner) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const url = `http://${runner.host}:${runner.port}/v1/health`;
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      // 不带 Authorization —— R1 阶段 /v1/health 不强制鉴权.
      // R2 把 /v1/health 锁了之后, 这里要把 token 也带过去, 见
      // docs/plans/runners.md §R2 阶段.
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `runner responded ${res.status} ${res.statusText}` },
        { status: 400 }
      );
    }
    const text = await res.text();
    // 校验响应是 JSON, 不解析, 直接落库. 上层 UI 展示不解析 JSON 是它的责任.
    try {
      JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "runner responded with non-JSON body" },
        { status: 400 }
      );
    }
    updateRunnerHealth(runner.id, text);
    return NextResponse.json({ ok: true, health: text });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return NextResponse.json(
      { error: `健康探针失败: ${msg}` },
      { status: 400 }
    );
  } finally {
    clearTimeout(timer);
  }
}
