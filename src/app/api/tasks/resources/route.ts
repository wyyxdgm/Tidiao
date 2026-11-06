// GET /api/tasks/resources - 批量采集运行中任务的 CPU/内存 (R232 任务看板资源徽章)
//
// 原理: agent SDK 子进程 env 带 ORCHESTRATOR_TASK_ID (buildEnv 注入), 扫 /proc
// 反查进程树聚合资源. 详见 src/lib/runtime/task-resources.ts.
//
// 关注点:
// - 普通用户: 只返回本人 task 的样本 (getTaskById owner 校验), host=null,
//   防跨用户探测. 管理员 (R232 追加): 返回全部任务样本 + titles + host 系统总览
//   (前端看板顶部分段进度条用).
// - 无命中进程的 task 不出现在响应里 (前端按「无数据/已退出」处理).
// - 🔴 只回 running 任务的样本 (2026-10-10): agent 在任务里起的 dev server /
//   pm2 业务服务继承 ORCHESTRATOR_TASK_ID 且长期存活, 任务结束照样命中 env →
//   非 running 任务被记上内存 (c6d50986 reviewing 记 206MB 实证). 任务自身
//   SDK 进程只在 running 期存活, 非 running 命中的都是遗留服务, 不算任务占用.
//   遗留服务多为部署产物, 不可杀, 只是不在任务徽章里展示.
// - /proc 扫描每进程 2 次 read, 几百进程几 ms; 前端 3s 轮询无压力.

import { NextRequest, NextResponse } from "next/server";
import {
  scanHostSummary,
  scanTaskResources,
  type TaskResourceSample,
} from "@/lib/runtime/task-resources";
import { getTaskById } from "@/lib/db/tasks";
import { getUserById } from "@/lib/db/users";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = getUserById(userId)?.role === "admin";

  // 先扫全量, 再逐个校验存在性 + 权限 + 状态 (只保留 running, 见头部关注点).
  const scanned = scanTaskResources();
  const tasks: Record<string, unknown> = {};
  const titles: Record<string, string> = {};
  for (const [taskId, sample] of scanned) {
    // admin 不传 userId = 不做 owner 过滤 (getTaskById 内部按参数拼 WHERE).
    const task = isAdmin ? getTaskById(taskId) : getTaskById(taskId, userId);
    if (!task) continue; // 不存在 / 已删 / (非 admin 时)非本人 → 丢弃
    if (task.status !== "running") continue; // 非 running 命中 = 遗留服务进程
    tasks[taskId] = sample;
    titles[taskId] = task.title;
  }

  // 系统总览仅管理员 (damo 2026-10-10 R232 追加口径); taskMemMB 只合计上面
  // 过滤后的 running 样本, 与任务徽章口径一致.
  const host = isAdmin
    ? scanHostSummary(new Map(Object.entries(tasks) as [string, TaskResourceSample][]))
    : null;

  return NextResponse.json({ tasks, titles, host, count: Object.keys(tasks).length });
}
