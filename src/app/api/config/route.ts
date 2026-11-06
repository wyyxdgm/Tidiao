// GET/PATCH /api/config - Runtime configuration
//
// T3 decision:
//   - GET is global read-only config (concurrency, queue depth, api-key
//     presence, base url, model). It is process-level state, not per-user
//     data, so any authenticated user may read it. The middleware already
//     rejects unauthenticated callers with 401.
//   - PATCH changes the shared scheduler's concurrency limit, which affects
//     every user on this single-machine (bt) deployment. Restricted to admin.

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import {
  getGlobalTaskTimeoutMinutes,
  setGlobalTaskTimeoutMinutes,
  setGlobalMaxConcurrency,
  MIN_TASK_TIMEOUT_MINUTES,
  MAX_TASK_TIMEOUT_MINUTES,
  MIN_MAX_CONCURRENCY,
  MAX_MAX_CONCURRENCY,
  getPortPool,
  setPortPool,
  MAX_POOL_SEGMENTS,
  MIN_PORT,
  MAX_PORT,
} from "@/lib/db/settings";

// 功能: 拼一份当前运行时配置, GET/PATCH 共用(PATCH 改完回同一份形状).
// 关注点: concurrency 回的是**调度器内存里正在生效的值**(权威), 库里存的是同一个值
//   —— PATCH 两处一起改; 库只在进程启动时被读一次。
function snapshot() {
  const scheduler = getRuntime().getScheduler();
  return {
    concurrency: scheduler.getConcurrency(),
    concurrency_min: MIN_MAX_CONCURRENCY,
    concurrency_max: MAX_MAX_CONCURRENCY,
    queue_size: scheduler.getQueueSize(),
    running_count: scheduler.getRunningCount(),
    api_key_configured: !!process.env.ANTHROPIC_API_KEY,
    base_url: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    model: process.env.ANTHROPIC_MODEL || null,
    // 全局默认壁钟超时(分钟)。项目可用 projects.timeout_minutes 覆盖。
    task_timeout_minutes: getGlobalTaskTimeoutMinutes(),
    task_timeout_min: MIN_TASK_TIMEOUT_MINUTES,
    task_timeout_max: MAX_TASK_TIMEOUT_MINUTES,
    // R18 P2: 端口池 (admin 配) + 边界常量, 给前端编辑面板用.
    port_pool: getPortPool(),
    port_pool_min: MIN_PORT,
    port_pool_max: MAX_PORT,
    port_pool_max_segments: MAX_POOL_SEGMENTS,
  };
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(snapshot());
}

export async function PATCH(request: NextRequest) {
  const role = request.headers.get("x-user-role");
  if (role !== "admin") {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }

  const body = await request.json();
  const runtime = getRuntime();
  const updatedBy = request.headers.get("x-user-id");

  // 并发上限: 必须**两处都改** —— 落库(重启后仍生效) + 改调度器内存值(立即生效)。
  // 只写库 = 要重启才生效; 只改内存 = pm2 重启回落(v39 前的老毛病)。
  // 先落库再改内存: 落库失败就不动运行时, 免得出现「跑着的值和库里不一致」。
  if (body.concurrency !== undefined) {
    let n: number;
    try {
      n = setGlobalMaxConcurrency(body.concurrency, updatedBy);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
    runtime.getScheduler().setConcurrency(n);
  }

  // 全局默认壁钟超时: 落库(app_settings), 下一次 start/resume 的任务生效 ——
  // 已在跑的任务按启动那一刻解析出的值超时, 不重挂定时器。
  // 非法值必须回 400: 静默忽略会让人以为超时调长了, 而任务照旧按旧值被挂起。
  if (body.task_timeout_minutes !== undefined) {
    try {
      setGlobalTaskTimeoutMinutes(body.task_timeout_minutes, updatedBy);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  }

  // R18 P2: 端口池. 改完**不**级联校验现有项目是否仍在池内 —— 项目 ports 是
  // 历史的「当时能分配到的」, 池缩小后旧项目可能「出池」, 但端口已分配 + 在
  // 用, 改池不等同于迁移项目. 后续如果需要, 可以加一项「池外项目告警」卡片.
  if (body.port_pool !== undefined) {
    try {
      setPortPool(body.port_pool, updatedBy);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  }

  // Note: API key and base URL are env vars set at process start,
  // they can't be changed at runtime via API. Show current values for info.

  // Return updated config
  return NextResponse.json(snapshot());
}
