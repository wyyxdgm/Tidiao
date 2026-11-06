// POST /api/tasks/[id]/resolve-decision — R127 §3.3 方案 A
// damo 在 board 一键决策. body: { decision_id, selected_label }.
// 副作用: 落 pending_decisions[decision_id].resolved_at/resolved_label, 写
//   decision_resolved event, 全 decision resolved 才 unset awaiting_owner_review.
// 不复用 resolveUserDialog: SDK session 已 close, in-flight Promise 句柄在 reviewing
//   状态会 console.warn 静默失效 (实测冲突 #3). 本路由纯读 metadata 落库.

import { NextRequest, NextResponse } from "next/server";
import { getTaskById, mutateTaskMetadata } from "@/lib/db/tasks";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { insertEvent } from "@/lib/db/events";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_RE = /^[A-Za-z0-9 _.,:/()\[\]-]{1,64}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  // 鉴权 + 状态机: task 存在 + owner 匹配 + 状态 ∈ {reviewing}.
  // 不允许 admin 越权 (与 approveTask 一致, 单一身份走到底).
  const task = getTaskById(id, userId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.status !== "reviewing") {
    return NextResponse.json(
      { error: `Task ${id} is not in reviewing state (current: ${task.status})` },
      { status: 409 },
    );
  }

  // body 解析 + 严格校验 (防字段错位 + 注入).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const decisionId = typeof b.decision_id === "string" ? b.decision_id : "";
  const selectedLabel = typeof b.selected_label === "string" ? b.selected_label : "";

  if (!UUID_RE.test(decisionId)) {
    return NextResponse.json(
      { error: "decision_id must be a UUID" },
      { status: 400 },
    );
  }
  if (!LABEL_RE.test(selectedLabel)) {
    return NextResponse.json(
      { error: "selected_label invalid (1-64 chars, charset restricted)" },
      { status: 400 },
    );
  }

  // 解析 pending_decisions + 校验 decision_id 命中 + selected_label ∈ options.label.
  let meta: Record<string, unknown> = {};
  try {
    meta = task.metadata ? JSON.parse(task.metadata) : {};
  } catch {
    return NextResponse.json(
      { error: "Task metadata corrupted" },
      { status: 500 },
    );
  }
  const pd = meta.pending_decisions;
  if (!pd || typeof pd !== "object") {
    return NextResponse.json(
      { error: "No pending_decisions on this task" },
      { status: 404 },
    );
  }
  const decision = (pd as Record<string, unknown>)[decisionId];
  if (!decision || typeof decision !== "object") {
    return NextResponse.json(
      { error: `decision_id ${decisionId} not found in pending_decisions` },
      { status: 404 },
    );
  }
  const decObj = decision as Record<string, unknown>;
  const alreadyResolved = typeof decObj.resolved_at === "string";
  if (alreadyResolved) {
    return NextResponse.json(
      {
        error: "Decision already resolved",
        resolved_label: decObj.resolved_label,
        resolved_at: decObj.resolved_at,
      },
      { status: 409 },
    );
  }
  const options = Array.isArray(decObj.options) ? decObj.options : [];
  const labelOk = options.some((o) => {
    if (!o || typeof o !== "object") return false;
    return (o as Record<string, unknown>).label === selectedLabel;
  });
  if (!labelOk) {
    return NextResponse.json(
      {
        error: `selected_label '${selectedLabel}' not in options[].label`,
        options: options.map((o) =>
          o && typeof o === "object"
            ? (o as Record<string, unknown>).label
            : null,
        ),
      },
      { status: 400 },
    );
  }

  // 落库: mutateTaskMetadata 改 resolved_at/resolved_label. 同一函数内 read-modify-write,
  //   避免 updateTask 全字段覆盖把别人刚写的键抹掉 (resume-contract 红线).
  const resolvedAt = new Date().toISOString();
  let updated = false;
  try {
    updated = mutateTaskMetadata(id, (m) => {
      const cur =
        m.pending_decisions && typeof m.pending_decisions === "object"
          ? (m.pending_decisions as Record<string, unknown>)
          : {};
      const dec = cur[decisionId];
      if (!dec || typeof dec !== "object") return false;
      // 二次校验: 防 race (两次并发 resolve 同一 decision_id, 第一笔成功后第二笔看到
      //   resolved_at 仍然没设, 因为 mutateTaskMetadata 这次读的是 DB 旧值). 此时
      //   第二笔不应该覆盖第一笔结果, 而是抛 conflict 让前端认输.
      if (typeof (dec as Record<string, unknown>).resolved_at === "string") {
        return false;
      }
      (dec as Record<string, unknown>).resolved_at = resolvedAt;
      (dec as Record<string, unknown>).resolved_label = selectedLabel;
      m.pending_decisions = cur;
      return true;
    });
  } catch (err) {
    return NextResponse.json(
      { error: `mutateTaskMetadata failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
  if (!updated) {
    return NextResponse.json(
      { error: "Concurrent resolve detected — abort" },
      { status: 409 },
    );
  }

  // 落 decision_resolved event (UI timeline / 后续规则引擎 nudge 用).
  insertEvent({
    task_id: id,
    type: "decision_resolved",
    data: JSON.stringify({
      decision_id: decisionId,
      selected_label: selectedLabel,
      by_user_id: userId,
      resolved_at: resolvedAt,
    }),
  });

  // 检查所有 decision 是否都 resolved. 是 → unset awaiting_owner_review (走专用 API,
  //   与 damo 手动 unset 走同条路径, 闸门与 race 兜底一致).
  let allResolved = false;
  mutateTaskMetadata(id, (m) => {
    const cur =
      m.pending_decisions && typeof m.pending_decisions === "object"
        ? (m.pending_decisions as Record<string, unknown>)
        : {};
    allResolved = Object.values(cur).every(
      (d) => d && typeof d === "object" && typeof (d as Record<string, unknown>).resolved_at === "string",
    );
    return false; // 不写库, 只读
  });

  if (allResolved) {
    try {
      getRuntime().unsetAwaitingOwnerReview(id);
    } catch (err) {
      // unset 失败不应影响决策已落库的事实 — log 后让前端刷新重试.
      console.warn(
        `[resolve-decision] unsetAwaitingOwnerReview failed for task ${id}:`,
        (err as Error).message,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    decision_id: decisionId,
    selected_label: selectedLabel,
    resolved_at: resolvedAt,
    all_resolved: allResolved,
  });
}
